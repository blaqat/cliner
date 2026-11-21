import { parseYamlFrontmatter } from "@core/context/instructions/user-instructions/frontmatter"
import { looksRunnable, type SkillItemFile } from "@shared/skillsets"
import * as fs from "fs/promises"
import * as yaml from "js-yaml"
import * as path from "path"

/** Files a skill folder can hold before listing stops (a skill is a handful of files). */
const MAX_LISTED_FILES = 200
/** Files bigger than this stay out of a shared set. */
export const MAX_SHARED_FILE_BYTES = 2 * 1024 * 1024

/** Dotfiles (.env, .git, .DS_Store) and dependency folders never travel in a set. */
export function isPrivateFile(relativePath: string): boolean {
	return relativePath
		.split(/[\\/]/)
		.some((segment) => segment.startsWith(".") || segment === "node_modules" || segment === "__pycache__")
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

/** Writes a file only inside `root`: a path that resolves anywhere else throws. */
export async function writeInside(root: string, relative: string, data: Buffer | string, mode?: number): Promise<string> {
	const target = path.resolve(root, relative)
	const base = path.resolve(root)
	if (target !== base && !target.startsWith(base + path.sep)) throw new Error(`Refusing to write outside ${root}: ${relative}`)
	await fs.mkdir(path.dirname(target), { recursive: true })
	await fs.writeFile(target, data)
	if (mode && mode & 0o111) await fs.chmod(target, 0o755).catch(() => {})
	return target
}

export async function exists(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath)
		return true
	} catch {
		return false
	}
}
