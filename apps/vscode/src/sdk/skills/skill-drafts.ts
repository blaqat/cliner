import { type AgentTool, createTool } from "@cline/shared"
import { SKILL_DRAFTS_ID, type SkillDraftMeta, type SkillItemKind, slugifySkillName } from "@shared/skillsets"
import type { NotebookChange } from "@shared/task-groups"
import * as fs from "fs/promises"
import * as path from "path"
import type { NotebookStore } from "../task-groups/notebook-store"
import { assertSafePath, buildSkillMarkdown, exists, parseSkillMarkdown, shareableWorkflow, writeInside } from "./skill-files"
import { safeZipPath } from "./zip"

/** Where skills and workflows are found and kept; injected so tests use temp folders. */
export interface SkillDraftPlaces {
	/** The open workspace, if any. */
	workspaceRoot?: string
	/** The six folders skills load from, in the loader's order. */
	skillScanDirs(): { path: string; isGlobal: boolean }[]
	/** Where a new skill goes for a scope (~/.agents/skills or <workspace>/.agents/skills). */
	skillsDir(scope: "global" | "workspace"): Promise<string>
	/** Where a new workflow goes for a scope. */
	workflowsDir(scope: "global" | "workspace"): Promise<string>
	/** Folders workflows are found in (global, then workspace). */
	workflowDirs(): Promise<{ path: string; isGlobal: boolean }[]>
}

export interface SkillDraftContext {
	rootThreadId: string
	store: NotebookStore
	places: SkillDraftPlaces
}

interface SkillDraftInput {
	kind: SkillItemKind
	name: string
	description?: string
	content: string
	files?: { path: string; content: string }[]
	scope?: "global" | "workspace"
	summary?: string
}

const MAX_EXTRA_FILES = 20
const MAX_FILE_CHARS = 200_000

const FRONT_MATTER = /^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)(?:[ \t]*\r?\n)*/

/**
 * A workflow's front matter, exactly as written, and the body below it. The agent sends
 * only a body, so an edit is diffed against the body and kept under the same front matter.
 */
function splitWorkflow(text: string): { head: string; body: string } {
	const head = text.match(FRONT_MATTER)?.[0] ?? ""
	return { head, body: text.slice(head.length) }
}

/** `text` with the line endings `like` uses, so keeping a one-line edit of a CRLF file changes one line. */
function withLineEndings(text: string, like: string): string {
	return like.includes("\r\n") ? text.replace(/\r?\n/g, "\r\n") : text
}

interface ExistingItem {
	kind: SkillItemKind
	name: string
	path: string
	isGlobal: boolean
}

/** Every skill and workflow the user has, for the tool's index and for edits. */
export async function listExistingItems(places: SkillDraftPlaces): Promise<ExistingItem[]> {
	const items: ExistingItem[] = []
	const seen = new Set<string>()
	for (const dir of places.skillScanDirs()) {
		const names = await fs.readdir(dir.path).catch(() => [] as string[])
		for (const name of names.sort()) {
			const skillMd = path.join(dir.path, name, "SKILL.md")
			if (seen.has(`skill:${name}`) || !(await exists(skillMd))) continue
			seen.add(`skill:${name}`)
			items.push({ kind: "skill", name, path: skillMd, isGlobal: dir.isGlobal })
		}
	}
	for (const dir of await places.workflowDirs()) {
		const names = await fs.readdir(dir.path).catch(() => [] as string[])
		for (const file of names.sort()) {
			if (!(await shareableWorkflow(path.join(dir.path, file)))) continue
			const name = file.replace(/\.md$/i, "")
			if (seen.has(`workflow:${name}`)) continue
			seen.add(`workflow:${name}`)
			items.push({ kind: "workflow", name, path: path.join(dir.path, file), isGlobal: dir.isGlobal })
		}
	}
	return items
}

/**
 * Lets the agent propose a new skill or workflow, or an edit to one, when the
 * user asks ("can we make this a skill", /skill). Nothing is written: the
 * proposal is staged and the user keeps, edits or drops it in the turn's
 * review row, like note changes.
 */
export async function createSkillDraftTool(context: SkillDraftContext): Promise<AgentTool> {
	const { store, rootThreadId, places } = context
	let index = await listExistingItems(places)
	const baseDescription =
		"Propose a new skill or workflow, or a change to an existing one, when the user asks you to turn work into a " +
		'skill or workflow (for example "can we make this a skill"). Always use this tool for that: never write ' +
		"SKILL.md or workflow files with file-editing tools, so the user can review the proposal first. A skill is instructions Cline loads by itself when a task matches its description (it can " +
		"carry extra files such as scripts/ and references/). A workflow is steps the user starts by typing /its-name. " +
		"Pick the one that fits and say why in one line. Nothing is written: the proposal is staged for the user to " +
		"review when you finish. content is the markdown body only (no front matter); for an edit, pass the full new " +
		"body. Scope global (all projects, the default) or workspace (this project only)."
	const tool = createTool<SkillDraftInput, string | { error: string }>({
		name: "skill_draft",
		description: baseDescription,
		inputSchema: {
			type: "object",
			properties: {
				kind: { type: "string", enum: ["skill", "workflow"] },
				name: { type: "string", description: "lowercase-with-dashes; an existing name edits that one" },
				description: {
					type: "string",
					description: "Skill: one line saying when to use it (Cline matches tasks against it)",
				},
				content: { type: "string", description: "The markdown body, without front matter" },
				files: {
					type: "array",
					description: "Skill only: extra files relative to the skill folder, e.g. scripts/check.sh",
					items: {
						type: "object",
						properties: { path: { type: "string" }, content: { type: "string" } },
						required: ["path", "content"],
					},
				},
				scope: { type: "string", enum: ["global", "workspace"] },
				summary: { type: "string", description: "One short line for the user: what this is and why" },
			},
			required: ["kind", "name", "content"],
		},
		retryable: false,
		execute: async (input) => {
			try {
				if (input.kind !== "skill" && input.kind !== "workflow") return { error: "kind must be skill or workflow." }
				const slug = slugifySkillName(input.name ?? "")
				if (!slug) return { error: "Use a name with letters or numbers, like release-checklist." }
				if (typeof input.content !== "string" || !input.content.trim()) return { error: "content is required." }
				if (input.kind === "workflow" && input.files?.length) {
					return { error: "Workflows are a single file; put scripts in a skill instead." }
				}
				const files: { path: string; content: string }[] = []
				for (const file of input.files ?? []) {
					let relative: string
					try {
						relative = safeZipPath(file.path)
					} catch {
						return { error: `Use a path inside the skill folder: ${file.path}` }
					}
					if (relative.endsWith("/") || /^skill\.md$/i.test(relative)) {
						return { error: `Put the SKILL.md text in content, not files: ${file.path}` }
					}
					if (typeof file.content !== "string" || file.content.length > MAX_FILE_CHARS) {
						return { error: `${file.path} is missing or too long.` }
					}
					files.push({ path: relative, content: file.content })
				}
				if (files.length > MAX_EXTRA_FILES) return { error: `A skill can carry at most ${MAX_EXTRA_FILES} extra files.` }
				const scope = input.scope === "workspace" ? "workspace" : "global"
				if (scope === "workspace" && !places.workspaceRoot) {
					return { error: "No workspace folder is open; use scope global." }
				}
				index = await listExistingItems(places)
				const existing = index.find((item) => item.kind === input.kind && item.name === slug)
				const pending = (await store.readPending(SKILL_DRAFTS_ID, rootThreadId)) ?? []
				const draftKey = `${input.kind}-${slug}`
				const staged = pending.find((change) => change.slug === draftKey)
				let baseContent: string | undefined
				let description = input.description?.trim() ?? ""
				if (existing) {
					const text = await fs.readFile(existing.path, "utf8")
					const parsed = parseSkillMarkdown(text)
					baseContent = input.kind === "skill" ? parsed.body : splitWorkflow(text).body
					description ||= parsed.description ?? ""
				}
				if (input.kind === "skill" && !description) {
					return { error: "A skill needs a description: one line saying when Cline should use it." }
				}
				const baseFiles: Record<string, string | null> = Object.fromEntries(
					[input.kind === "skill" ? "SKILL.md" : `${slug}.md`, ...files.map((file) => file.path)].map((file) => [
						file,
						null,
					]),
				)
				if (existing) {
					for (const relative of [path.basename(existing.path), ...files.map((file) => file.path)]) {
						const target = await assertSafePath(path.dirname(existing.path), relative)
						baseFiles[relative] = await readDraftBase(target)
					}
				}
				const skill: SkillDraftMeta = {
					kind: input.kind,
					scope: existing ? (existing.isGlobal ? "global" : "workspace") : scope,
					baseFiles,
					...(files.length ? { files } : {}),
					...(existing
						? { targetPath: existing.path, baseContent, baseFiles: { ...baseFiles, ...staged?.skill?.baseFiles } }
						: {}),
				}
				const change: NotebookChange = {
					op: existing ? "update" : "create",
					slug: draftKey,
					name: slug,
					description,
					content: input.content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, ""),
					...(input.summary?.trim() ? { summary: input.summary.trim().slice(0, 200) } : {}),
					skill: staged?.skill ? { ...skill, scope: staged.skill.scope, kind: input.kind } : skill,
				}
				await store.stageChange(SKILL_DRAFTS_ID, rootThreadId, change)
				return `Staged; the user reviews the ${input.kind} when you finish.`
			} catch (error) {
				return { error: error instanceof Error ? error.message : String(error) }
			}
		},
	})
	Object.defineProperty(tool, "description", {
		get() {
			const lines = index
				.slice(0, 40)
				.map(
					(item) =>
						`- ${item.kind === "workflow" ? "/" : ""}${item.name} (${item.kind}, ${item.isGlobal ? "global" : "workspace"}): ${item.path}`,
				)
			if (index.length > 40) lines.push(`${index.length - 40} more`)
			return `${baseDescription}\n\nExisting skills and workflows (read a file before editing it):\n${lines.join("\n") || "None yet."}`
		},
		enumerable: true,
		configurable: true,
	})
	return tool as AgentTool
}

/** Exact disk bytes, including binary extras. Missing is different from empty. */
async function readDraftBase(target: string): Promise<string | null> {
	try {
		return (await fs.readFile(target)).toString("base64")
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
		throw error
	}
}

/**
 * Keeps a staged skill or workflow: writes its files and switches it on (the
 * user just made it). Returns the change's slug, as the notebook's apply does.
 */
export async function applySkillDraft(
	change: NotebookChange,
	editedContent: string | undefined,
	places: SkillDraftPlaces,
	setEnabled: (kind: SkillItemKind, itemPath: string, isGlobal: boolean) => Promise<void>,
): Promise<string> {
	const draft = change.skill
	if (!draft) throw new Error(`${change.name} isn't a skill or workflow.`)
	if (change.op === "delete") throw new Error("Skills can't be deleted from the review row.")
	const body = editedContent ?? change.content ?? ""
	const name = slugifySkillName(change.name) || change.slug
	if (draft.scope === "workspace" && !places.workspaceRoot) {
		throw new Error(`Open a folder to keep ${name} in this workspace, or switch Where to All projects.`)
	}
	const isGlobal = draft.scope === "global"
	const keepsTarget = !!draft.targetPath && (draft.kind === "skill") === /SKILL\.md$/i.test(draft.targetPath)
	if (keepsTarget && draft.targetPath) {
		const root = path.dirname(draft.targetPath)
		const relatives = [
			path.basename(draft.targetPath),
			...(draft.kind === "skill" ? (draft.files ?? []).map((file) => file.path) : []),
		]
		const conflict: Record<string, string | null> = {}
		// Preflight every file before writing the main file or any extras.
		for (const relative of relatives) {
			const target = await assertSafePath(root, relative)
			const current = await readDraftBase(target)
			if (!draft.baseFiles || current !== draft.baseFiles[relative]) conflict[relative] = current
		}
		if (Object.keys(conflict).length) {
			draft.conflict = conflict
			throw new Error(`${name} changed on disk. Open its chip and choose Keep mine, Keep theirs, or Open both.`)
		}
		delete draft.conflict
	}
	if (draft.kind === "skill") {
		let dir: string
		let extra: Record<string, unknown> = {}
		let current = ""
		if (keepsTarget && draft.targetPath) {
			dir = path.dirname(draft.targetPath)
			current = await fs.readFile(draft.targetPath, "utf8").catch(() => "")
			extra = parseSkillMarkdown(current).extra
		} else {
			const root = await places.skillsDir(draft.scope)
			let folder = name
			for (let n = 2; await exists(path.join(root, folder)); n++) folder = `${name}-${n}`
			dir = path.join(root, folder)
		}
		for (const file of draft.files ?? []) await assertSafePath(dir, file.path)
		const skillMd = await writeInside(
			dir,
			"SKILL.md",
			withLineEndings(
				buildSkillMarkdown(body, {
					name: path.basename(dir),
					description: change.description || name,
					disabled: extra.disabled === true,
					extra,
				}),
				current,
			),
		)
		// A script the agent wrote (a shebang) is executable, as it would be in a shared set.
		for (const file of draft.files ?? [])
			await writeInside(dir, file.path, file.content, file.content.startsWith("#!") ? 0o755 : undefined)
		if (!keepsTarget) await setEnabled("skill", skillMd, isGlobal)
		return change.slug
	}
	let target: string
	let current = ""
	if (keepsTarget && draft.targetPath) {
		target = draft.targetPath
		current = await fs.readFile(target, "utf8").catch(() => "")
	} else {
		const root = await places.workflowsDir(draft.scope)
		let file = name
		for (let n = 2; await exists(path.join(root, `${file}.md`)); n++) file = `${name}-${n}`
		target = path.join(root, `${file}.md`)
	}
	const text = `${splitWorkflow(current).head}${body.endsWith("\n") ? body : `${body}\n`}`
	await writeInside(path.dirname(target), path.basename(target), withLineEndings(text, current))
	if (!keepsTarget) await setEnabled("workflow", target, isGlobal)
	return change.slug
}
