import { promises as fs } from "node:fs"
import { parseYamlFrontmatter } from "@core/context/instructions/user-instructions/frontmatter"
import type { NotebookActivity, NotebookChange, NotebookNoteMeta } from "@shared/task-groups"
import * as yaml from "js-yaml"
import { Logger } from "@/shared/services/Logger"
import { taskGroupPaths, taskGroupsRootDir, writeFileAtomic } from "./task-group-store"

type NoteUpdatedBy = NotebookNoteMeta["updatedBy"]

/** Kebab-case the note name; the slug is the note's `<slug>.md` filename. */
export function slugifyNoteName(name: string): string {
	return name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
}

function parseUpdatedBy(raw: unknown): NoteUpdatedBy {
	if (typeof raw === "object" && raw !== null) {
		const updatedBy = raw as Record<string, unknown>
		if (updatedBy.kind === "thread" && typeof updatedBy.threadId === "string" && updatedBy.threadId) {
			return {
				kind: "thread",
				threadId: updatedBy.threadId,
				threadTitle: typeof updatedBy.threadTitle === "string" ? updatedBy.threadTitle : "",
			}
		}
	}
	// "user", a missing field (hand-created files), or an unrecognized shape.
	return { kind: "user" }
}

function serializeNote(input: {
	name: string
	description: string
	updatedAt: number
	updatedBy: NoteUpdatedBy
	body: string
}): string {
	const updatedBy =
		input.updatedBy.kind === "thread"
			? { kind: "thread", threadId: input.updatedBy.threadId, threadTitle: input.updatedBy.threadTitle }
			: { kind: "user" }
	const frontmatter = yaml
		.dump({
			name: input.name,
			description: input.description,
			updated: new Date(input.updatedAt).toISOString(),
			updatedBy,
		})
		.trimEnd()
	return `---\n${frontmatter}\n---\n\n${input.body}`
}

function parseActivityLine(line: string): NotebookActivity | undefined {
	try {
		const raw = JSON.parse(line) as Record<string, unknown>
		if (
			typeof raw.ts !== "number" ||
			typeof raw.threadId !== "string" ||
			(raw.kind !== "read" && raw.kind !== "write") ||
			typeof raw.slug !== "string"
		) {
			return undefined
		}
		return { ts: raw.ts, threadId: raw.threadId, kind: raw.kind, slug: raw.slug }
	} catch {
		return undefined
	}
}

/**
 * Notebook storage inside a task-group directory: `notebook/<slug>.md` notes
 * (YAML frontmatter + markdown body), `pending/<threadId>.json` staged agent
 * changes, and the append-only `activity.jsonl` read/write log that powers
 * the timeline's note chips and reader counts.
 */
export class NotebookStore {
	private readonly noteIndexes = new Map<string, NotebookNoteMeta[]>()
	private readonly stageWrites = new Map<string, Promise<void>>()

	constructor(private readonly rootDir: string = taskGroupsRootDir()) {}

	getNoteIndex(groupId: string): NotebookNoteMeta[] {
		return this.noteIndexes.get(groupId) ?? []
	}

	async refreshNoteIndexes(): Promise<void> {
		await Promise.all([...this.noteIndexes.keys()].map((groupId) => this.listNotes(groupId)))
	}

	// ---- Notes ----

	async listNotes(groupId: string): Promise<NotebookNoteMeta[]> {
		const paths = taskGroupPaths(this.rootDir, groupId)
		let files: string[]
		try {
			files = (await fs.readdir(paths.notebookDir)).filter((file) => file.endsWith(".md"))
		} catch {
			this.noteIndexes.set(groupId, [])
			return []
		}
		const readerCounts = await this.readerCounts(groupId)
		const notes: NotebookNoteMeta[] = []
		for (const file of files) {
			const slug = file.slice(0, -".md".length)
			const note = await this.readNoteMeta(groupId, slug)
			if (note) notes.push({ ...note, readers: readerCounts.get(slug) ?? 0 })
		}
		notes.sort((a, b) => b.updatedAt - a.updatedAt)
		this.noteIndexes.set(groupId, notes)
		return notes
	}

	async readThreadNote(
		groupId: string,
		rootThreadId: string,
		slug: string,
		readerThreadId: string,
	): Promise<{ name: string; content: string } | undefined> {
		const staged = (await this.readPending(groupId, rootThreadId))?.find((change) => change.slug === slug)
		if (staged) {
			if (staged.op === "delete") return undefined
			await this.appendActivity(groupId, { ts: Date.now(), threadId: readerThreadId, kind: "read", slug })
			return { name: staged.name, content: staged.content ?? "" }
		}
		const note = await this.readNote(groupId, slug, readerThreadId)
		return note ? { name: note.meta.name, content: note.content } : undefined
	}

	/**
	 * Reads a note's markdown body (frontmatter stripped). When `threadId` is
	 * given, appends a `read` activity entry for the timeline/reader counts.
	 */
	async readNote(
		groupId: string,
		slug: string,
		threadId?: string,
	): Promise<{ meta: NotebookNoteMeta; content: string } | undefined> {
		const filePath = taskGroupPaths(this.rootDir, groupId).noteFile(slug)
		try {
			const raw = await fs.readFile(filePath, "utf8")
			const meta = await this.readNoteMeta(groupId, slug, raw)
			if (!meta) return undefined
			if (threadId) {
				await this.appendActivity(groupId, { ts: Date.now(), threadId, kind: "read", slug })
			}
			return { meta, content: parseYamlFrontmatter(raw).body.trimStart() }
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				Logger.warn(`[NotebookStore] Failed to read note ${groupId}/${slug}:`, error)
			}
			return undefined
		}
	}

	/**
	 * Creates a note file and returns its slug and absolute path. The slug is
	 * the kebab-cased name, made unique within the group's notebook.
	 */
	async createNote(groupId: string, input: { name: string; description: string }): Promise<{ slug: string; path: string }> {
		const paths = taskGroupPaths(this.rootDir, groupId)
		await fs.mkdir(paths.notebookDir, { recursive: true })
		const slug = await this.uniqueSlug(groupId, input.name)
		const filePath = paths.noteFile(slug)
		const content = serializeNote({
			name: input.name.trim(),
			description: input.description.trim(),
			updatedAt: Date.now(),
			updatedBy: { kind: "user" },
			body: "",
		})
		await writeFileAtomic(filePath, content)
		return { slug, path: filePath }
	}

	notePath(groupId: string, slug: string): string {
		return taskGroupPaths(this.rootDir, groupId).noteFile(slug)
	}

	// ---- Staged changes (pending/<threadId>.json) ----

	/**
	 * Stage a notebook change for a thread. Merges with an already-staged
	 * change for the same slug: a `create` stays a `create` on later writes,
	 * and a `create` followed by a `delete` cancels out entirely.
	 */
	async stageChange(groupId: string, threadId: string, change: NotebookChange): Promise<void> {
		const key = `${groupId}/${threadId}`
		const write = (this.stageWrites.get(key) ?? Promise.resolve())
			.catch(() => {})
			.then(() => this.performStageChange(groupId, threadId, change))
		this.stageWrites.set(key, write)
		try {
			await write
		} finally {
			if (this.stageWrites.get(key) === write) this.stageWrites.delete(key)
		}
	}

	private async performStageChange(groupId: string, threadId: string, change: NotebookChange): Promise<void> {
		const pending = (await this.readPending(groupId, threadId)) ?? []
		const index = pending.findIndex((entry) => entry.slug === change.slug)
		if (index === -1) {
			pending.push(change)
		} else {
			const prev = pending[index]
			if (prev.op === "create" && change.op === "delete") {
				pending.splice(index, 1)
			} else {
				pending[index] = {
					...change,
					op: prev.op === "create" ? "create" : change.op === "create" ? "update" : change.op,
				}
			}
		}
		const pendingPath = taskGroupPaths(this.rootDir, groupId).pendingFile(threadId)
		// A cancelled-out stage (e.g. create then delete) leaves nothing to review —
		// the wrap-up card keys on a non-empty pending file.
		if (pending.length === 0) {
			await fs.rm(pendingPath, { force: true })
			return
		}
		await fs.mkdir(taskGroupPaths(this.rootDir, groupId).pendingDir, { recursive: true })
		await writeFileAtomic(pendingPath, `${JSON.stringify(pending, null, 2)}\n`)
	}

	async readPending(groupId: string, threadId: string): Promise<NotebookChange[] | undefined> {
		const pendingPath = taskGroupPaths(this.rootDir, groupId).pendingFile(threadId)
		try {
			const raw = JSON.parse(await fs.readFile(pendingPath, "utf8"))
			if (!Array.isArray(raw)) return undefined
			return raw.filter(
				(entry): entry is NotebookChange =>
					typeof entry === "object" &&
					entry !== null &&
					["create", "update", "delete"].includes((entry as NotebookChange).op) &&
					typeof (entry as NotebookChange).slug === "string" &&
					typeof (entry as NotebookChange).name === "string",
			)
		} catch {
			return undefined
		}
	}

	/**
	 * Finds the staged-changes file for a thread across all groups — apply and
	 * discard are keyed by threadId only, and the thread's group membership can
	 * change while changes sit pending.
	 */
	async findPending(threadId: string): Promise<{ groupId: string; changes: NotebookChange[] } | undefined> {
		let groupIds: string[]
		try {
			groupIds = await fs.readdir(this.rootDir)
		} catch {
			return undefined
		}
		for (const groupId of groupIds) {
			const changes = await this.readPending(groupId, threadId)
			if (changes !== undefined) {
				return { groupId, changes }
			}
		}
		return undefined
	}

	/**
	 * Applies a thread's staged changes. `items` selects which staged changes
	 * to apply (by slug, `include`) and can carry the user's inline edits
	 * (`editedContent`); staged changes without a matching item are skipped.
	 * The pending file is removed either way — review happens once.
	 */
	async applyPendingChanges(
		threadId: string,
		items: { slug: string; include: boolean; editedContent?: string }[],
		options?: { threadTitle?: string },
	): Promise<NotebookChange[]> {
		const pending = await this.findPending(threadId)
		if (!pending) return []
		const { groupId, changes } = pending
		const applied: NotebookChange[] = []
		try {
			for (const change of changes) {
				const item = items.find((entry) => entry.slug === change.slug)
				if (!item?.include) continue
				await this.applyChange(groupId, change, item.editedContent, {
					kind: "thread",
					threadId,
					threadTitle: options?.threadTitle ?? "",
				})
				applied.push(
					item.editedContent !== undefined && change.op !== "delete"
						? { ...change, content: item.editedContent }
						: change,
				)
				await this.appendActivity(groupId, { ts: Date.now(), threadId, kind: "write", slug: change.slug })
			}
		} finally {
			await fs.rm(taskGroupPaths(this.rootDir, groupId).pendingFile(threadId), { force: true })
		}
		return applied
	}

	async discardPendingChanges(threadId: string): Promise<void> {
		const pending = await this.findPending(threadId)
		if (!pending) return
		await fs.rm(taskGroupPaths(this.rootDir, pending.groupId).pendingFile(threadId), { force: true })
	}

	// ---- Activity log ----

	async appendActivity(groupId: string, activity: NotebookActivity): Promise<void> {
		const paths = taskGroupPaths(this.rootDir, groupId)
		try {
			await fs.mkdir(paths.dir, { recursive: true })
			await fs.appendFile(paths.activityFile, `${JSON.stringify(activity)}\n`, "utf8")
		} catch (error) {
			Logger.warn(`[NotebookStore] Failed to append activity for ${groupId}:`, error)
		}
	}

	async listActivity(groupId: string): Promise<NotebookActivity[]> {
		const paths = taskGroupPaths(this.rootDir, groupId)
		try {
			const raw = await fs.readFile(paths.activityFile, "utf8")
			return raw
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line.length > 0)
				.map(parseActivityLine)
				.filter((entry): entry is NotebookActivity => entry !== undefined)
		} catch {
			return []
		}
	}

	/** Per-thread note slugs for the task page timeline (read/wrote chips). */
	async summarizeActivity(groupId: string): Promise<Map<string, { read: string[]; wrote: string[] }>> {
		const summary = new Map<string, { read: Set<string>; wrote: Set<string> }>()
		for (const activity of await this.listActivity(groupId)) {
			let entry = summary.get(activity.threadId)
			if (!entry) {
				entry = { read: new Set(), wrote: new Set() }
				summary.set(activity.threadId, entry)
			}
			;(activity.kind === "read" ? entry.read : entry.wrote).add(activity.slug)
		}
		return new Map(
			Array.from(summary.entries()).map(([threadId, entry]) => [
				threadId,
				{ read: [...entry.read], wrote: [...entry.wrote] },
			]),
		)
	}

	/** Distinct reader threads per note slug. */
	private async readerCounts(groupId: string): Promise<Map<string, number>> {
		const readers = new Map<string, Set<string>>()
		for (const activity of await this.listActivity(groupId)) {
			if (activity.kind !== "read") continue
			let set = readers.get(activity.slug)
			if (!set) {
				set = new Set()
				readers.set(activity.slug, set)
			}
			set.add(activity.threadId)
		}
		return new Map(Array.from(readers.entries()).map(([slug, threads]) => [slug, threads.size]))
	}

	// ---- Internals ----

	private async applyChange(
		groupId: string,
		change: NotebookChange,
		editedContent: string | undefined,
		updatedBy: NoteUpdatedBy,
	): Promise<void> {
		const paths = taskGroupPaths(this.rootDir, groupId)
		const filePath = paths.noteFile(change.slug)
		if (change.op === "delete") {
			await fs.rm(filePath, { force: true })
			return
		}
		// `baseUpdatedAt` records which on-disk revision the agent based the
		// change on; apply wins unconditionally because the user already
		// reviewed the staged content (and can edit it inline before applying).
		const existing = await fs.readFile(filePath, "utf8").catch(() => undefined)
		const body = editedContent ?? change.content ?? (existing !== undefined ? parseYamlFrontmatter(existing).body : "")
		const name = change.name.trim() || change.slug
		await fs.mkdir(paths.notebookDir, { recursive: true })
		await writeFileAtomic(
			filePath,
			serializeNote({
				name,
				description: change.description,
				updatedAt: Date.now(),
				updatedBy,
				body,
			}),
		)
	}

	private async readNoteMeta(groupId: string, slug: string, rawOverride?: string): Promise<NotebookNoteMeta | undefined> {
		const filePath = taskGroupPaths(this.rootDir, groupId).noteFile(slug)
		try {
			const raw = rawOverride ?? (await fs.readFile(filePath, "utf8"))
			const stat = await fs.stat(filePath)
			const { data } = parseYamlFrontmatter(raw)
			const updated =
				typeof data.updated === "string" && Number.isFinite(Date.parse(data.updated))
					? Date.parse(data.updated)
					: stat.mtimeMs
			return {
				slug,
				name: typeof data.name === "string" && data.name ? data.name : slug,
				description: typeof data.description === "string" ? data.description : "",
				size: stat.size,
				updatedAt: updated,
				updatedBy: parseUpdatedBy(data.updatedBy),
				readers: 0,
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				Logger.warn(`[NotebookStore] Failed to read note meta ${groupId}/${slug}:`, error)
			}
			return undefined
		}
	}

	private async uniqueSlug(groupId: string, name: string): Promise<string> {
		const paths = taskGroupPaths(this.rootDir, groupId)
		const base = slugifyNoteName(name) || "note"
		let slug = base
		for (let i = 2; ; i++) {
			try {
				await fs.access(paths.noteFile(slug))
				slug = `${base}-${i}`
			} catch {
				return slug
			}
		}
	}
}
