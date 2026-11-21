import { parseYamlFrontmatter } from "@core/context/instructions/user-instructions/frontmatter"
import { looksRunnable, type SkillItemFile } from "@shared/skillsets"
import { constants } from "fs"
import * as fs from "fs/promises"
import * as yaml from "js-yaml"
import * as path from "path"

/** Files a skill folder can hold before listing stops (a skill is a handful of files). */
const MAX_LISTED_FILES = 401
/** Files bigger than this stay out of a shared set. */
export const MAX_SHARED_FILE_BYTES = 2 * 1024 * 1024

/** Dotfiles (.env, .git, .DS_Store) and dependency folders never travel in a set. */
export function isPrivateFile(relativePath: string): boolean {
	return relativePath
		.split(/[\\/]/)
		.some(
			(segment) =>
				segment.startsWith(".") ||
				/^(credentials?|secrets?|tokens?|passwords?)([.-]|$)/i.test(segment) ||
				segment === "node_modules" ||
				segment === "__pycache__",
		)
}

/**
 * The SKILL.md text for a skill: front matter with the name (which must match
 * the folder), the description, and any other keys kept as they were.
 */
export function buildSkillMarkdown(
	body: string,
	fields: { name: string; description: string; disabled?: boolean; extra?: Record<string, unknown> },
): string {
	const data: Record<string, unknown> = { ...(fields.extra ?? {}), name: fields.name, description: fields.description }
	delete data.enabled
	if (fields.disabled) data.disabled = true
	else delete data.disabled
	const frontmatter = yaml.dump(data, { lineWidth: -1 }).trimEnd()
	return `---\n${frontmatter}\n---\n\n${body.replace(/^\s+/, "")}`.replace(/\s*$/, "\n")
}

/** Reads a SKILL.md: its front matter fields and the body below them. */
export function parseSkillMarkdown(text: string): {
	name?: string
	description?: string
	body: string
	extra: Record<string, unknown>
} {
	const { data, body } = parseYamlFrontmatter(text)
	const { name, description, ...extra } = data
	return {
		name: typeof name === "string" ? name : undefined,
		description: typeof description === "string" ? description : undefined,
		body,
		extra,
	}
}

/** A description for a skill that came without one: its first heading or line. */
export function fallbackDescription(body: string, name: string): string {
	const line = body
		.split("\n")
		.map((entry) => entry.replace(/^#+\s*/, "").trim())
		.find(Boolean)
	return (line ?? `The ${name} skill`).slice(0, 200)
}

/**
 * Every file in a skill folder (relative paths, forward slashes), with which
 * ones run code. Private files are listed separately, never followed links.
 */
export async function listSkillFiles(dir: string): Promise<{ files: SkillItemFile[]; skipped: string[] }> {
	const files: SkillItemFile[] = []
	const skipped: string[] = []
	const walk = async (relative: string): Promise<void> => {
		if (files.length >= MAX_LISTED_FILES) return
		let entries: import("fs").Dirent[]
		try {
			entries = await fs.readdir(path.join(dir, relative), { withFileTypes: true })
		} catch {
			return
		}
		entries.sort((a, b) => a.name.localeCompare(b.name))
		for (const entry of entries) {
			const rel = relative ? `${relative}/${entry.name}` : entry.name
			if (isPrivateFile(rel)) {
				if (entry.name !== ".DS_Store") skipped.push(rel)
				continue
			}
			if (entry.isSymbolicLink()) {
				skipped.push(rel)
				continue
			}
			if (entry.isDirectory()) {
				await walk(rel)
				continue
			}
			if (!entry.isFile()) continue
			const stat = await fs.stat(path.join(dir, rel)).catch(() => undefined)
			if (!stat) continue
			if (stat.size > MAX_SHARED_FILE_BYTES) {
				skipped.push(rel)
				continue
			}
			files.push({
				path: rel,
				size: stat.size,
				...(rel !== "SKILL.md" && looksRunnable(rel, stat.mode) ? { runsCode: true } : {}),
			})
			if (files.length >= MAX_LISTED_FILES) return
		}
	}
	await walk("")
	// SKILL.md first, then the rest in path order.
	files.sort((a, b) => (a.path === "SKILL.md" ? -1 : b.path === "SKILL.md" ? 1 : a.path.localeCompare(b.path)))
	return { files, skipped }
}

/** Refuse existing links, including a replaced destination folder or file. */
export async function assertSafePath(root: string, relative = ""): Promise<string> {
	const base = path.resolve(root)
	const target = path.resolve(base, relative)
	if (target !== base && !target.startsWith(base + path.sep)) throw new Error("Choose a file inside the skill folder.")
	let current = path.parse(target).root
	for (const part of target.slice(current.length).split(path.sep)) {
		current = path.join(current, part)
		const stat = await fs.lstat(current).catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return undefined
			throw error
		})
		// macOS exposes its temporary directory through these system aliases.
		if (stat?.isSymbolicLink() && !["/var", "/tmp"].includes(current)) {
			throw new Error(
				`Can't use a linked folder or file: ${current}. Replace the link with a regular folder or file and try again.`,
			)
		}
	}
	return target
}

/** Writes only through regular directories and refuses a linked destination. */
export async function writeInside(root: string, relative: string, data: Buffer | string, mode?: number): Promise<string> {
	const target = await assertSafePath(root, relative)
	await fs.mkdir(path.dirname(target), { recursive: true })
	await assertSafePath(root, relative)
	const handle = await fs.open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o644)
	try {
		await handle.writeFile(data)
		if (mode && mode & 0o111) await handle.chmod(0o755)
	} finally {
		await handle.close()
	}
	return target
}

/** Share only regular, public markdown workflows, with no linked parent folders. */
export async function shareableWorkflow(file: string): Promise<boolean> {
	const parts = path.resolve(file).split(path.sep)
	let workflowRoot = -1
	for (let i = 0; i < parts.length; i++) if (/^workflows$/i.test(parts[i])) workflowRoot = i
	const relative = workflowRoot >= 0 ? parts.slice(workflowRoot + 1).join("/") : path.basename(file)
	if (!/\.md$/i.test(file) || isPrivateFile(relative)) return false
	try {
		await assertSafePath(path.dirname(file), path.basename(file))
		const stat = await fs.lstat(file)
		return stat.isFile() && stat.size <= MAX_SHARED_FILE_BYTES
	} catch {
		return false
	}
}

export async function exists(filePath: string): Promise<boolean> {
	try {
		await fs.lstat(filePath)
		return true
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
		return false
	}
}
