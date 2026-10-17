import { createHash, randomUUID } from "node:crypto"
import { promises as fs } from "node:fs"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { parseYamlFrontmatter } from "@core/context/instructions/user-instructions/frontmatter"
import type { NotebookActivity, NotebookChange, NotebookNoteMeta, NotebookVersion } from "@shared/task-groups"
import * as yaml from "js-yaml"
import { Logger } from "@/shared/services/Logger"
import { compactNotebookDiff, notebookDiff } from "./notebook-diff"
import { taskGroupPaths, taskGroupsRootDir, validateTaskGroupIdentifier, writeFileAtomic } from "./task-group-store"

export interface PendingNotebookChanges {
	groupId: string
	revision: string
	changes: NotebookChange[]
}

/** A user's editor save the store rejected (stale revision, busy lock). Never lost until persisted or discarded. */
export interface NotebookEditDraft {
	content: string
	ts: number
	reason: string
}

type NoteUpdatedBy = NotebookNoteMeta["updatedBy"]

const PENDING_LOCK_TIMEOUT_MS = 30_000

async function pendingLockIsStale(lockPath: string): Promise<boolean> {
	let raw: string
	let modifiedAt: number
	try {
		raw = await fs.readFile(lockPath, "utf8")
		modifiedAt = (await fs.stat(lockPath)).mtimeMs
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
		throw error
	}
	try {
		const { pid } = JSON.parse(raw)
		if (Number.isSafeInteger(pid) && pid > 0) {
			try {
				process.kill(pid, 0)
				return false
			} catch (error) {
				// EPERM also means the owner exists. Never expire a live writer.
				return (error as NodeJS.ErrnoException).code === "ESRCH"
			}
		}
	} catch {
		// A process can die between exclusive creation and writing its owner.
	}
	return Date.now() - modifiedAt > PENDING_LOCK_TIMEOUT_MS
}

async function recoverPendingLock(lockPath: string): Promise<void> {
	// Serialize stale cleanup too: two waiters must not unlink each other's
	// newly acquired lock after both observed the same dead owner.
	const recoveryPath = `${lockPath}.recovery`
	try {
		await fs.mkdir(recoveryPath)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
		try {
			if (Date.now() - (await fs.stat(recoveryPath)).mtimeMs > PENDING_LOCK_TIMEOUT_MS) {
				await fs.rmdir(recoveryPath)
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
		}
		return
	}
	try {
		if (await pendingLockIsStale(lockPath)) await fs.rm(lockPath, { force: true })
	} finally {
		await fs.rmdir(recoveryPath)
	}
}

/** Kebab-case the note name; the slug is the note's `<slug>.md` filename. */
export function slugifyNoteName(name: string): string {
	return name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 128)
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
	private readonly pendingWrites = new Map<string, Promise<unknown>>()

	constructor(private readonly rootDir: string = taskGroupsRootDir()) {}

	getNoteIndex(groupId: string): NotebookNoteMeta[] {
		validateTaskGroupIdentifier(groupId, "groupId")
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
			try {
				validateTaskGroupIdentifier(slug, "slug")
			} catch {
				continue
			}
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
		taskGroupPaths(this.rootDir, groupId).noteFile(slug)
		validateTaskGroupIdentifier(readerThreadId, "threadId")
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
		if (threadId !== undefined) validateTaskGroupIdentifier(threadId, "threadId")
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
		const content = serializeNote({
			name: input.name.trim(),
			description: input.description.trim(),
			updatedAt: Date.now(),
			updatedBy: { kind: "user" },
			body: "",
		})
		const slug = await this.createExclusive(groupId, slugifyNoteName(input.name) || "note", content)
		await this.recordVersion(groupId, slug, "", "original")
		return { slug, path: paths.noteFile(slug) }
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
	private async serializePending<T>(groupId: string, threadId: string, operation: () => Promise<T>): Promise<T> {
		validateTaskGroupIdentifier(threadId, "threadId")
		const write = (this.pendingWrites.get(threadId) ?? Promise.resolve())
			.catch(() => {})
			.then(() => this.withPendingLock(groupId, threadId, operation))
		this.pendingWrites.set(threadId, write)
		try {
			return await write
		} finally {
			if (this.pendingWrites.get(threadId) === write) this.pendingWrites.delete(threadId)
		}
	}

	private async withPendingLock<T>(groupId: string, threadId: string, operation: () => Promise<T>): Promise<T> {
		const paths = taskGroupPaths(this.rootDir, groupId)
		const lockPath = paths.pendingFile(threadId).replace(/\.json$/, ".lock")
		await fs.mkdir(paths.pendingDir, { recursive: true })
		const startedAt = Date.now()
		while (true) {
			let handle: Awaited<ReturnType<typeof fs.open>>
			try {
				handle = await fs.open(lockPath, "wx")
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
				await recoverPendingLock(lockPath)
				if (Date.now() - startedAt >= PENDING_LOCK_TIMEOUT_MS) {
					throw new Error("Notebook changes are busy in another window. Try again.")
				}
				await delay(10 + Math.floor(Math.random() * 20))
				continue
			}
			try {
				await handle.writeFile(JSON.stringify({ pid: process.pid, timestamp: Date.now() }))
				return await operation()
			} finally {
				try {
					await handle.close()
				} finally {
					await fs.rm(lockPath, { force: true })
				}
			}
		}
	}

	async stageChange(groupId: string, threadId: string, change: NotebookChange): Promise<void> {
		taskGroupPaths(this.rootDir, groupId).noteFile(change.slug)
		return this.serializePending(groupId, threadId, () => this.performStageChange(groupId, threadId, change))
	}

	private async performStageChange(groupId: string, threadId: string, change: NotebookChange): Promise<void> {
		await this.captureSavedVersion(groupId, change.slug)
		const pending = (await this.readPending(groupId, threadId)) ?? []
		const index = pending.findIndex((entry) => entry.slug === change.slug)
		if (index === -1) {
			pending.push(change)
		} else {
			const prev = pending[index]
			if (prev.editedByUser) {
				const version = await this.recordVersion(groupId, prev.slug, prev.content ?? "", "you edited")
				change = { ...change, replacedUserVersion: version.id }
			} else if (prev.replacedUserVersion) change = { ...change, replacedUserVersion: prev.replacedUserVersion }
			if (prev.op === "create" && change.op === "delete") {
				await this.settleDraft(groupId, threadId, change.slug)
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
		await this.writePending(groupId, threadId, pending)
	}

	private async writePending(groupId: string, threadId: string, changes: NotebookChange[]): Promise<void> {
		const paths = taskGroupPaths(this.rootDir, groupId)
		if (!changes.length) {
			await fs.rm(paths.pendingFile(threadId), { force: true })
			return
		}
		await fs.mkdir(paths.pendingDir, { recursive: true })
		await writeFileAtomic(paths.pendingFile(threadId), `${JSON.stringify({ revision: randomUUID(), changes }, null, 2)}\n`)
	}

	async readPending(groupId: string, threadId: string): Promise<NotebookChange[] | undefined> {
		return (await this.readPendingReview(groupId, threadId))?.changes
	}

	async readPendingReview(groupId: string, threadId: string): Promise<PendingNotebookChanges | undefined> {
		const pendingPath = taskGroupPaths(this.rootDir, groupId).pendingFile(threadId)
		try {
			const text = await fs.readFile(pendingPath, "utf8")
			const raw = JSON.parse(text)
			// Old pending arrays remain reviewable with a stable content revision.
			const changes = Array.isArray(raw) ? raw : raw.changes
			const revision = Array.isArray(raw) ? createHash("sha256").update(text).digest("hex") : raw.revision
			if (!Array.isArray(changes) || typeof revision !== "string" || !revision) return undefined
			for (const entry of changes) {
				if (!entry || !["create", "update", "delete"].includes(entry.op) || typeof entry.name !== "string")
					return undefined
				validateTaskGroupIdentifier(entry.slug, "slug")
			}
			return { groupId, revision, changes }
		} catch {
			return undefined
		}
	}

	async reviewDiffs(review: PendingNotebookChanges, threadId?: string): Promise<PendingNotebookChanges> {
		const drafts = threadId ? await this.readDrafts(review.groupId, threadId) : {}
		return {
			...review,
			changes: await Promise.all(
				review.changes.map(async (change) => ({
					...change,
					...(drafts[change.slug] ? { draft: { ts: drafts[change.slug].ts, reason: drafts[change.slug].reason } } : {}),
					diff: notebookDiff(
						(await this.readNote(review.groupId, change.slug))?.content ?? "",
						change.op === "delete" ? "" : (change.content ?? ""),
					),
				})),
			),
		}
	}

	async listPending(threadId: string): Promise<PendingNotebookChanges[]> {
		validateTaskGroupIdentifier(threadId, "threadId")
		let groupIds: string[]
		try {
			groupIds = await fs.readdir(this.rootDir)
		} catch {
			return []
		}
		const pending: PendingNotebookChanges[] = []
		for (const groupId of groupIds) {
			try {
				validateTaskGroupIdentifier(groupId, "groupId")
			} catch {
				continue
			}
			const review = await this.readPendingReview(groupId, threadId)
			if (review?.changes.length) pending.push(review)
		}
		return pending
	}

	/** Compatibility lookup; review actions always address a specific group and revision. */
	async findPending(threadId: string): Promise<PendingNotebookChanges | undefined> {
		return (await this.listPending(threadId))[0]
	}

	private async requireRevision(groupId: string, threadId: string, revision: string): Promise<PendingNotebookChanges> {
		const pending = await this.readPendingReview(groupId, threadId)
		if (!revision || !pending || pending.revision !== revision) {
			throw new Error("Notebook changes have changed since this review. Use the newest review card.")
		}
		return pending
	}

	async applyPendingChanges(
		groupId: string,
		threadId: string,
		revision: string,
		items: { slug: string; include: boolean; editedContent?: string }[],
		options?: { threadTitle?: string },
	): Promise<NotebookChange[]> {
		taskGroupPaths(this.rootDir, groupId).pendingFile(threadId)
		for (const item of items) validateTaskGroupIdentifier(item.slug, "slug")
		return this.serializePending(groupId, threadId, async () => {
			const { changes } = await this.requireRevision(groupId, threadId, revision)
			const applied: NotebookChange[] = []
			const completed = new Set<string>()
			try {
				for (const change of changes) {
					const item = items.find((entry) => entry.slug === change.slug)
					if (!item?.include) continue
					await this.settleDraft(groupId, threadId, change.slug)
					const slug = await this.applyChange(groupId, change, item.editedContent, {
						kind: "thread",
						threadId,
						threadTitle: options?.threadTitle ?? "",
					})
					completed.add(change.slug)
					applied.push({
						...change,
						slug,
						...(item.editedContent !== undefined && change.op !== "delete" ? { content: item.editedContent } : {}),
					})
					await this.appendActivity(groupId, { ts: Date.now(), threadId, kind: "write", slug })
				}
			} catch (error) {
				// Preserve failed and unprocessed work, including the user's inline edits.
				await this.writePending(
					groupId,
					threadId,
					changes
						.filter((change) => !completed.has(change.slug))
						.map((change) => {
							const item = items.find((entry) => entry.slug === change.slug)
							return item?.editedContent !== undefined && change.op !== "delete"
								? { ...change, content: item.editedContent }
								: change
						}),
				)
				throw error
			}
			// Only successful operations leave pending; unchecked work stays reviewable.
			await this.writePending(
				groupId,
				threadId,
				changes.filter((change) => !completed.has(change.slug)),
			)
			return applied
		})
	}

	async discardPendingChanges(groupId: string, threadId: string, revision: string): Promise<void> {
		taskGroupPaths(this.rootDir, groupId).pendingFile(threadId)
		return this.serializePending(groupId, threadId, async () => {
			const pending = await this.requireRevision(groupId, threadId, revision)
			for (const change of pending.changes) await this.settleDraft(groupId, threadId, change.slug)
			for (const change of pending.changes)
				await this.queueNotice(
					groupId,
					threadId,
					change.slug,
					`The user discarded your pending edits to \`${change.name}\``,
				)
			await this.writePending(groupId, threadId, [])
		})
	}

	async conversions(groupId: string, slug: string): Promise<{ kind: string; path: string }[]> {
		const file = this.historyPath(groupId, slug).replace(/\.json$/, ".conversions.json")
		try {
			return JSON.parse(await fs.readFile(file, "utf8"))
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
			return []
		}
	}

	async addConversion(groupId: string, slug: string, link: { kind: string; path: string }): Promise<void> {
		const links = await this.conversions(groupId, slug)
		await fs.mkdir(join(taskGroupPaths(this.rootDir, groupId).dir, "note-history"), { recursive: true })
		await writeFileAtomic(
			this.historyPath(groupId, slug).replace(/\.json$/, ".conversions.json"),
			JSON.stringify([...links, link]),
		)
	}

	private historyPath(groupId: string, slug: string): string {
		const paths = taskGroupPaths(this.rootDir, groupId)
		paths.noteFile(slug)
		return join(paths.dir, "note-history", `${slug}.json`)
	}

	async history(groupId: string, slug: string): Promise<NotebookVersion[]> {
		try {
			return JSON.parse(await fs.readFile(this.historyPath(groupId, slug), "utf8"))
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
			return []
		}
	}

	async recordVersion(groupId: string, slug: string, content: string, by: string): Promise<NotebookVersion> {
		const lockId = `history-${createHash("sha256").update(slug).digest("hex")}`
		return this.serializePending(groupId, lockId, () => this.writeVersion(groupId, slug, content, by))
	}

	private async writeVersion(groupId: string, slug: string, content: string, by: string): Promise<NotebookVersion> {
		const versions = await this.history(groupId, slug)
		const last = versions[versions.length - 1]
		if (last?.content === content) return last
		const version = { id: randomUUID(), ts: Date.now(), content, by }
		versions.push(version)
		const retained = versions.length > 21 ? [versions[0], ...versions.slice(-20)] : versions
		await fs.mkdir(join(taskGroupPaths(this.rootDir, groupId).dir, "note-history"), { recursive: true })
		await writeFileAtomic(this.historyPath(groupId, slug), JSON.stringify(retained))
		return version
	}

	async captureSavedVersion(groupId: string, slug: string): Promise<void> {
		const note = await this.readNote(groupId, slug)
		if (note) await this.recordVersion(groupId, slug, note.content, "saved")
	}

	async restoreVersion(groupId: string, slug: string, versionId: string): Promise<void> {
		const version = (await this.history(groupId, slug)).find((version) => version.id === versionId)
		if (!version) throw new Error("Version no longer available")
		const note = await this.readNote(groupId, slug)
		if (!note) throw new Error("Note no longer exists")
		await this.captureSavedVersion(groupId, slug)
		await writeFileAtomic(
			this.notePath(groupId, slug),
			serializeNote({ ...note.meta, body: version.content, updatedAt: Date.now(), updatedBy: { kind: "user" } }),
		)
		await this.recordVersion(groupId, slug, version.content, "restored by you")
	}

	/**
	 * `supersedesDraftTs` names the rejected-save draft this edit replaces (Retry
	 * or a reopened draft editor); that draft is dropped only once the edit is
	 * persisted, and a newer draft is never touched.
	 */
	async editPending(
		groupId: string,
		threadId: string,
		revision: string,
		slug: string,
		content: string,
		options?: { supersedesDraftTs?: number },
	): Promise<string> {
		return this.serializePending(groupId, threadId, async () => {
			const pending = await this.requireRevision(groupId, threadId, revision)
			const change = pending.changes.find((change) => change.slug === slug)
			if (!change) throw new Error("Pending note no longer available")
			if (change.op === "delete") change.op = (await this.readNote(groupId, slug)) ? "update" : "create"
			await this.captureSavedVersion(groupId, slug)
			const before = change.content ?? ""
			await this.recordVersion(groupId, slug, content, "you edited")
			change.content = content
			change.editedByUser = true
			delete change.replacedUserVersion
			await this.writePending(groupId, threadId, pending.changes)
			await this.queueNotice(
				groupId,
				threadId,
				slug,
				`The user edited the pending note \`${change.name}\`; build on this version`,
				{ before, after: content },
			)
			const updated = await this.readPendingReview(groupId, threadId)
			if (!updated) throw new Error("Pending note was removed while saving")
			if (options?.supersedesDraftTs !== undefined) {
				const drafts = await this.readDrafts(groupId, threadId)
				if (drafts[slug]?.ts === options.supersedesDraftTs) {
					delete drafts[slug]
					await this.writeDrafts(groupId, threadId, drafts)
				}
			}
			return updated.revision
		})
	}

	// ---- Rejected-save drafts (pending/<threadId>.drafts.json) ----

	private draftsPath(groupId: string, threadId: string): string {
		return taskGroupPaths(this.rootDir, groupId)
			.pendingFile(threadId)
			.replace(/\.json$/, ".drafts.json")
	}

	async readDrafts(groupId: string, threadId: string): Promise<Record<string, NotebookEditDraft>> {
		try {
			const raw = JSON.parse(await fs.readFile(this.draftsPath(groupId, threadId), "utf8"))
			const drafts: Record<string, NotebookEditDraft> = {}
			for (const [slug, draft] of Object.entries<NotebookEditDraft>(raw ?? {})) {
				if (typeof draft?.content === "string") drafts[slug] = draft
			}
			return drafts
		} catch {
			return {}
		}
	}

	private async writeDrafts(groupId: string, threadId: string, drafts: Record<string, NotebookEditDraft>): Promise<void> {
		const file = this.draftsPath(groupId, threadId)
		if (!Object.keys(drafts).length) {
			await fs.rm(file, { force: true })
			return
		}
		await fs.mkdir(taskGroupPaths(this.rootDir, groupId).pendingDir, { recursive: true })
		await writeFileAtomic(file, JSON.stringify(drafts))
	}

	/**
	 * Keeps the text of an editor save that couldn't be applied. While the note
	 * is still under review it becomes a draft the card offers Retry / Reload
	 * for; otherwise (the review is gone) it goes straight to the note's history.
	 * Throws if nothing could be persisted, so the caller keeps its temp file.
	 */
	async saveRejectedEdit(
		groupId: string,
		threadId: string,
		slug: string,
		content: string,
		reason: string,
	): Promise<{ kind: "draft"; ts: number } | { kind: "history" }> {
		taskGroupPaths(this.rootDir, groupId).noteFile(slug)
		return this.serializePending(groupId, threadId, async () => {
			const pending = await this.readPendingReview(groupId, threadId)
			if (!pending?.changes.some((change) => change.slug === slug)) {
				await this.recordVersion(groupId, slug, content, "your unsaved edit")
				return { kind: "history" }
			}
			const drafts = await this.readDrafts(groupId, threadId)
			const previous = drafts[slug]
			// A second rejected save replaces the draft; the older text moves to history.
			if (previous && previous.content !== content)
				await this.recordVersion(groupId, slug, previous.content, "your unsaved edit")
			const ts = Date.now()
			drafts[slug] = { content, ts, reason }
			await this.writeDrafts(groupId, threadId, drafts)
			return { kind: "draft", ts }
		})
	}

	async discardDraft(groupId: string, threadId: string, slug: string): Promise<void> {
		taskGroupPaths(this.rootDir, groupId).noteFile(slug)
		await this.serializePending(groupId, threadId, async () => {
			const drafts = await this.readDrafts(groupId, threadId)
			if (!drafts[slug]) return
			delete drafts[slug]
			await this.writeDrafts(groupId, threadId, drafts)
		})
	}

	/** Called under the pending lock when a review is applied or discarded: the draft text moves to history, never vanishes. */
	private async settleDraft(groupId: string, threadId: string, slug: string): Promise<void> {
		const drafts = await this.readDrafts(groupId, threadId)
		const draft = drafts[slug]
		if (!draft) return
		await this.recordVersion(groupId, slug, draft.content, "your unsaved edit")
		delete drafts[slug]
		await this.writeDrafts(groupId, threadId, drafts)
	}

	private noticePath(groupId: string, threadId: string): string {
		return taskGroupPaths(this.rootDir, groupId)
			.pendingFile(threadId)
			.replace(/\.json$/, ".notices.json")
	}

	private async queueNotice(
		groupId: string,
		threadId: string,
		slug: string,
		text: string,
		edit?: { before: string; after: string },
	): Promise<void> {
		const file = this.noticePath(groupId, threadId)
		const notices: { slug: string; text: string; base?: string }[] = JSON.parse(
			await fs.readFile(file, "utf8").catch(() => "[]"),
		)
		const base = edit ? (notices.find((notice) => notice.slug === slug)?.base ?? edit.before) : undefined
		const notice = { slug, text: edit ? `${text}\n${compactNotebookDiff(base ?? "", edit.after)}` : text, base }
		// A discard replaces an undelivered edit notice, so discarded text never reaches the agent.
		await writeFileAtomic(file, JSON.stringify([...notices.filter((notice) => notice.slug !== slug), notice]))
	}

	async consumeNotices(groupId: string, threadId: string): Promise<string | undefined> {
		return this.serializePending(groupId, threadId, async () => {
			const file = this.noticePath(groupId, threadId)
			const notices: { text: string }[] = JSON.parse(await fs.readFile(file, "utf8").catch(() => "[]"))
			await fs.rm(file, { force: true })
			return notices.length ? notices.map((notice) => notice.text).join("\n\n") : undefined
		})
	}

	// ---- Activity log ----

	async appendActivity(groupId: string, activity: NotebookActivity): Promise<void> {
		validateTaskGroupIdentifier(activity.threadId, "threadId")
		validateTaskGroupIdentifier(activity.slug, "slug")
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
	): Promise<string> {
		const paths = taskGroupPaths(this.rootDir, groupId)
		const filePath = paths.noteFile(change.slug)
		if (change.op === "delete") {
			const previous = await this.readNote(groupId, change.slug)
			if (previous) await this.recordVersion(groupId, change.slug, previous.content, "saved")
			await fs.rm(filePath, { force: true })
			return change.slug
		}
		// `baseUpdatedAt` records which on-disk revision the agent based the
		// change on; apply wins unconditionally because the user already
		// reviewed the staged content (and can edit it inline before applying).
		const existing = await fs.readFile(filePath, "utf8").catch(() => undefined)
		const body = editedContent ?? change.content ?? (existing !== undefined ? parseYamlFrontmatter(existing).body : "")
		const name = change.name.trim() || change.slug
		await fs.mkdir(paths.notebookDir, { recursive: true })
		const content = serializeNote({ name, description: change.description, updatedAt: Date.now(), updatedBy, body })
		if (change.op === "create") {
			const slug = await this.createExclusive(groupId, change.slug, content)
			await this.recordVersion(groupId, slug, body, "thread")
			return slug
		}
		if (existing !== undefined)
			await this.recordVersion(groupId, change.slug, parseYamlFrontmatter(existing).body.trimStart(), "saved")
		await this.recordVersion(groupId, change.slug, body, "thread")
		await writeFileAtomic(filePath, content)
		return change.slug
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
				updatedAt: stat.mtimeMs > updated + 2000 ? stat.mtimeMs : updated,
				updatedBy: stat.mtimeMs > updated + 2000 ? { kind: "user" } : parseUpdatedBy(data.updatedBy),
				readers: 0,
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				Logger.warn(`[NotebookStore] Failed to read note meta ${groupId}/${slug}:`, error)
			}
			return undefined
		}
	}

	private async createExclusive(groupId: string, base: string, content: string): Promise<string> {
		const paths = taskGroupPaths(this.rootDir, groupId)
		validateTaskGroupIdentifier(base, "slug")
		for (let i = 1; ; i++) {
			const suffix = i === 1 ? "" : `-${i}`
			const slug = `${base.slice(0, 128 - suffix.length)}${suffix}`
			try {
				const filePath = paths.noteFile(slug)
				const handle = await fs.open(filePath, "wx")
				try {
					await handle.writeFile(content, "utf8")
				} catch (error) {
					await fs.rm(filePath, { force: true })
					throw error
				} finally {
					await handle.close()
				}
				return slug
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
			}
		}
	}
}
