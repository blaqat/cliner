import { promises as fs } from "node:fs"
import path from "node:path"
import { formatDisplayUserInput } from "@cline/shared"
import { resolveSessionDataDir } from "@cline/shared/storage"
import { parseYamlFrontmatter } from "@core/context/instructions/user-instructions/frontmatter"
import type { HistorySearchHit, HistorySearchThread } from "@shared/task-groups"
import { Logger } from "@/shared/services/Logger"
import { TaskGroupStore, taskGroupPaths, taskGroupsRootDir } from "./task-group-store"

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200
const SNIPPET_LENGTH = 120
// Characters of context shown before the match when the hit sits mid-text.
const SNIPPET_CONTEXT = 40
const MAX_CACHE_ENTRIES = 256
// Per-file read cap: a multi-MB session file is read to EOF and parsed
// synchronously on the extension host, so oversized files are skipped rather
// than scanned.
const MAX_FILE_BYTES = 8 * 1024 * 1024
// Total file bytes the parse cache may hold; least-recently-used entries are
// evicted once cached bytes (or entry count) exceed the bound.
const MAX_CACHE_BYTES = 32 * 1024 * 1024
// Yield to the event loop every N files so a large history never monopolizes
// the extension host during a scan.
const FILES_PER_YIELD = 8

function yieldToEventLoop(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve))
}

function collapseWhitespace(input: string): string {
	return input.replace(/\s+/g, " ").trim()
}

function escapeRegExp(input: string): string {
	return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * A ~120-char window of `text` around the match at `matchIndex`, ellipsized
 * when the window doesn't reach the text's edges.
 */
function searchSnippet(text: string, matchIndex: number): string {
	if (text.length <= SNIPPET_LENGTH) {
		return text
	}
	const start = Math.min(Math.max(0, matchIndex - SNIPPET_CONTEXT), text.length - SNIPPET_LENGTH)
	const end = start + SNIPPET_LENGTH
	return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`
}

interface CachedFile<T> {
	value: T | undefined
	mtimeMs: number
}

/**
 * Parsed file contents keyed by path, invalidated on mtime or size change.
 * Search runs once per debounced keystroke, so re-reading every session file
 * each time would dominate. Two bounds keep memory flat: files larger than
 * `maxFileBytes` are skipped (not read at all), and the cache holds at most
 * `maxBytes` of file content across `maxEntries` files, evicting the
 * least-recently-used entries. `bytes` uses the on-disk size as a proxy for
 * the retained parse — close enough for a bound.
 */
class ParsedFileCache {
	private readonly entries = new Map<string, { mtimeMs: number; size: number; bytes: number; value: unknown }>()
	private totalBytes = 0

	constructor(
		private readonly maxEntries: number,
		private readonly maxBytes: number,
		private readonly maxFileBytes: number,
	) {}

	async read<T>(filePath: string, parse: (raw: string) => T | undefined): Promise<CachedFile<T> | undefined> {
		const stat = await fs.stat(filePath).catch(() => undefined)
		if (!stat?.isFile()) {
			return undefined
		}
		const cached = this.entries.get(filePath)
		if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
			this.entries.delete(filePath)
			this.entries.set(filePath, cached)
			return { value: cached.value as T | undefined, mtimeMs: stat.mtimeMs }
		}
		let value: T | undefined
		let bytes = 0
		if (stat.size > this.maxFileBytes) {
			// The skip decision is cached too, so an oversized file costs one
			// stat per search, not a read.
			Logger.warn(`[HistorySearcher] Skipping ${filePath}: ${stat.size} bytes exceeds the per-file search cap`)
		} else {
			try {
				value = parse(await fs.readFile(filePath, "utf8"))
				bytes = stat.size
			} catch (error) {
				Logger.warn(`[HistorySearcher] Failed to read ${filePath}:`, error)
			}
		}
		this.insert(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, bytes, value })
		return { value, mtimeMs: stat.mtimeMs }
	}

	private insert(filePath: string, entry: { mtimeMs: number; size: number; bytes: number; value: unknown }): void {
		const previous = this.entries.get(filePath)
		if (previous) {
			this.totalBytes -= previous.bytes
			this.entries.delete(filePath)
		}
		this.entries.set(filePath, entry)
		this.totalBytes += entry.bytes
		while (this.entries.size > 1 && (this.entries.size > this.maxEntries || this.totalBytes > this.maxBytes)) {
			const oldest = this.entries.keys().next().value
			if (oldest === undefined || oldest === filePath) {
				break
			}
			const evicted = this.entries.get(oldest)
			this.entries.delete(oldest)
			if (evicted) {
				this.totalBytes -= evicted.bytes
			}
		}
	}
}

interface SearchableMessage {
	/** Index into the session's raw `messages` array; used in the result id. */
	index: number
	ts: number
	/**
	 * Collapsed display text. Only the original is kept: matching runs a
	 * case-insensitive regex over it, so no lowercase copy is stored.
	 */
	text: string
}

function messageText(content: unknown): string {
	if (typeof content === "string") {
		return content
	}
	if (!Array.isArray(content)) {
		return ""
	}
	const parts: string[] = []
	for (const part of content) {
		const block = part as { type?: unknown; text?: unknown }
		if (block?.type === "text" && typeof block.text === "string") {
			parts.push(block.text)
		}
	}
	return parts.join(" ")
}

/**
 * Extracts the user/assistant text of `<id>.messages.json` for searching.
 * Returns undefined for malformed files — they're skipped, not fatal.
 */
function parseSessionMessages(raw: string): SearchableMessage[] | undefined {
	let data: { messages?: unknown }
	try {
		data = JSON.parse(raw)
	} catch {
		return undefined
	}
	if (!Array.isArray(data?.messages)) {
		return undefined
	}
	const messages: SearchableMessage[] = []
	for (let index = 0; index < data.messages.length; index++) {
		const message = data.messages[index] as { role?: unknown; content?: unknown; ts?: unknown }
		if (message?.role !== "user" && message?.role !== "assistant") {
			continue
		}
		const rawText = messageText(message.content)
		const text = collapseWhitespace(message.role === "user" ? formatDisplayUserInput(rawText) : rawText)
		if (!text) {
			continue
		}
		messages.push({ index, ts: typeof message.ts === "number" ? message.ts : 0, text })
	}
	return messages
}

/** Display title from `<id>.json`: user-set threadTitle, else task/prompt. */
function parseSessionManifestTitle(raw: string): string | undefined {
	try {
		const data = JSON.parse(raw) as {
			prompt?: unknown
			metadata?: { threadTitle?: unknown; title?: unknown }
		}
		const title = data.metadata?.threadTitle ?? data.metadata?.title ?? data.prompt
		if (typeof title !== "string" || !title.trim()) {
			return undefined
		}
		return formatDisplayUserInput(title) || undefined
	} catch {
		return undefined
	}
}

/**
 * The hit snippet when a note's name or description matches `pattern`, else
 * undefined. Both hits display the description — a window around the match
 * for description hits, the head of it for name hits.
 */
function noteMetaSnippet(note: { name: string; description: string }, pattern: RegExp): string | undefined {
	const description = collapseWhitespace(note.description)
	if (note.name.search(pattern) !== -1) {
		return searchSnippet(description, 0)
	}
	const matchIndex = description.search(pattern)
	return matchIndex === -1 ? undefined : searchSnippet(description, matchIndex)
}

interface SearchableNote {
	name: string
	description: string
	/** Frontmatter `updated` in ms since epoch, or 0 when absent/invalid. */
	updated: number
	/** Collapsed markdown body. */
	body: string
}

/**
 * Extracts a note's searchable text from `<slug>.md`: frontmatter
 * name/description plus the collapsed markdown body. Parsed through the
 * size-capped file cache, so oversized notes are never read and unchanged
 * notes are not re-parsed between searches.
 */
function parseSearchableNote(raw: string): SearchableNote {
	const { data, body } = parseYamlFrontmatter(raw)
	const updated = typeof data.updated === "string" ? Date.parse(data.updated) : Number.NaN
	return {
		name: typeof data.name === "string" ? data.name : "",
		description: typeof data.description === "string" ? data.description : "",
		updated: Number.isFinite(updated) ? updated : 0,
		body: collapseWhitespace(body),
	}
}

export interface HistorySearchOptions {
	/** Sessions root; defaults to resolveSessionDataDir(). Overridden in tests. */
	sessionsDir?: string
	/** Task-groups root; defaults to taskGroupsRootDir(). Overridden in tests. */
	taskGroupsDir?: string
	maxCacheEntries?: number
	maxCacheBytes?: number
	maxFileBytes?: number
}

/**
 * Server-side history search (Phase 6): note bodies across every task group's
 * notebook, and user/assistant message text across
 * `<sessionsDir>/<id>/<id>.messages.json`. Task and thread rows are fuzzy-
 * matched client-side, so those kinds return nothing here.
 */
export class HistorySearcher {
	private readonly sessionsDir: string
	private readonly taskGroupsDir: string
	private readonly taskGroupStore: TaskGroupStore
	private readonly fileCache: ParsedFileCache

	constructor(options: HistorySearchOptions = {}) {
		this.sessionsDir = options.sessionsDir ?? resolveSessionDataDir()
		this.taskGroupsDir = options.taskGroupsDir ?? taskGroupsRootDir()
		this.taskGroupStore = new TaskGroupStore(this.taskGroupsDir)
		this.fileCache = new ParsedFileCache(
			options.maxCacheEntries ?? MAX_CACHE_ENTRIES,
			options.maxCacheBytes ?? MAX_CACHE_BYTES,
			options.maxFileBytes ?? MAX_FILE_BYTES,
		)
	}

	async search(input: {
		query: string
		kind?: string
		limit?: number
		threads?: HistorySearchThread[]
		/** Checked between files; return true to abandon the scan early. */
		isCancelled?: () => boolean
	}): Promise<HistorySearchHit[]> {
		const query = collapseWhitespace(input.query).toLowerCase()
		if (!query) {
			return []
		}
		const requested = Math.floor(input.limit ?? 0)
		const limit = requested > 0 ? Math.min(requested, MAX_LIMIT) : DEFAULT_LIMIT
		const kind = input.kind ?? "all"
		const isCancelled = input.isCancelled ?? (() => false)
		// Case-insensitive substring match without holding a lowercased copy of
		// every file's text in the cache.
		const pattern = new RegExp(escapeRegExp(query), "i")
		const hits: HistorySearchHit[] = []
		if (kind === "all" || kind === "notes") {
			const noteHits = await this.searchNotes(pattern, limit, isCancelled)
			// Notes-only searches keep the meta-before-body ranking rather than
			// re-sorting purely by recency.
			if (kind === "notes") {
				return noteHits.slice(0, limit)
			}
			hits.push(...noteHits)
		}
		if (!isCancelled() && (kind === "all" || kind === "messages")) {
			hits.push(...(await this.searchMessages(pattern, limit, input.threads, isCancelled)))
		}
		hits.sort((a, b) => b.ts - a.ts)
		return hits.slice(0, limit)
	}

	private async searchNotes(pattern: RegExp, limit: number, isCancelled: () => boolean): Promise<HistorySearchHit[]> {
		// Name/description hits outrank body hits, so they're gathered apart and
		// returned first (each bucket newest-first).
		const metaHits: HistorySearchHit[] = []
		const bodyHits: HistorySearchHit[] = []
		let scanned = 0
		for (const group of await this.taskGroupStore.listGroups()) {
			if (isCancelled() || (metaHits.length >= limit && bodyHits.length >= limit)) break
			// Enumerate with readdir + stat only: name, description and body all
			// come from the bounded parse cache below, and search needs no reader
			// counts, so a cancelled scan never reads a note file or the group's
			// activity log.
			const paths = taskGroupPaths(this.taskGroupsDir, group.id)
			const names = await fs.readdir(paths.notebookDir).catch(() => [] as string[])
			const notes: { slug: string; path: string; mtimeMs: number }[] = []
			for (const name of names) {
				if (!name.endsWith(".md")) continue
				const slug = name.slice(0, -".md".length)
				let filePath: string
				try {
					filePath = paths.noteFile(slug)
				} catch {
					continue
				}
				const stat = await fs.stat(filePath).catch(() => undefined)
				if (stat?.isFile()) notes.push({ slug, path: filePath, mtimeMs: stat.mtimeMs })
				if (notes.length > 0 && notes.length % FILES_PER_YIELD === 0) await yieldToEventLoop()
			}
			// Newest first, so a hit limit keeps the most recent matches.
			notes.sort((a, b) => b.mtimeMs - a.mtimeMs)
			for (const note of notes) {
				if (isCancelled()) {
					return [...metaHits, ...bodyHits]
				}
				if (++scanned % FILES_PER_YIELD === 0) await yieldToEventLoop()
				// Files over the per-file cap are stat'ed but never read (the
				// cache returns no value for them).
				const parsed = await this.fileCache.read(note.path, parseSearchableNote)
				const value = parsed?.value
				if (!value) continue
				const title = value.name || note.slug
				// Same updatedAt rule as NotebookStore.readNoteMeta: the frontmatter
				// timestamp wins unless the file mtime is newer (hand edits).
				const ts = parsed.mtimeMs > value.updated + 2000 ? parsed.mtimeMs : value.updated || parsed.mtimeMs
				const metaSnippet = noteMetaSnippet({ name: title, description: value.description }, pattern)
				if (metaSnippet !== undefined) {
					if (metaHits.length < limit) {
						metaHits.push({
							kind: "note",
							id: note.slug,
							title,
							snippet: metaSnippet,
							ts,
							taskGroupId: group.id,
						})
					}
					continue
				}
				if (metaHits.length + bodyHits.length >= limit) continue
				const matchIndex = value.body.search(pattern)
				if (matchIndex === -1) continue
				bodyHits.push({
					kind: "note",
					id: note.slug,
					title,
					snippet: searchSnippet(value.body, matchIndex),
					ts,
					taskGroupId: group.id,
				})
			}
		}
		metaHits.sort((a, b) => b.ts - a.ts)
		bodyHits.sort((a, b) => b.ts - a.ts)
		return [...metaHits, ...bodyHits]
	}

	private async searchMessages(
		pattern: RegExp,
		limit: number,
		threads: HistorySearchThread[] | undefined,
		isCancelled: () => boolean,
	): Promise<HistorySearchHit[]> {
		const entries = await fs.readdir(this.sessionsDir, { withFileTypes: true }).catch(() => [])
		const files: { sessionId: string; path: string; mtimeMs: number }[] = []
		for (const entry of entries) {
			if (!entry.isDirectory()) continue
			const filePath = path.join(this.sessionsDir, entry.name, `${entry.name}.messages.json`)
			const stat = await fs.stat(filePath).catch(() => undefined)
			if (stat?.isFile()) {
				files.push({ sessionId: entry.name, path: filePath, mtimeMs: stat.mtimeMs })
			}
			if (files.length > 0 && files.length % FILES_PER_YIELD === 0) await yieldToEventLoop()
		}
		files.sort((a, b) => b.mtimeMs - a.mtimeMs)

		const threadIndex = new Map((threads ?? []).map((thread) => [thread.id, thread]))
		const hits: HistorySearchHit[] = []
		let scanned = 0
		for (const file of files) {
			if (isCancelled() || hits.length >= limit) break
			if (++scanned % FILES_PER_YIELD === 0) await yieldToEventLoop()
			const parsed = await this.fileCache.read(file.path, parseSessionMessages)
			if (!parsed?.value) continue
			// Newest messages first, so hitting the limit mid-file keeps the most
			// recent matches.
			for (let i = parsed.value.length - 1; i >= 0 && hits.length < limit; i--) {
				const message = parsed.value[i]
				const matchIndex = message.text.search(pattern)
				if (matchIndex === -1) continue
				const thread = threadIndex.get(file.sessionId)
				hits.push({
					kind: "message",
					id: `${file.sessionId}:${message.index}`,
					threadId: file.sessionId,
					taskGroupId: thread?.taskGroupId,
					title: thread?.title ?? (await this.sessionTitle(file.sessionId)) ?? "",
					ts: message.ts || thread?.ts || file.mtimeMs,
					snippet: searchSnippet(message.text, matchIndex),
				})
			}
		}
		return hits
	}

	/** Title for a session absent from task history, from its `<id>.json` manifest. */
	private async sessionTitle(sessionId: string): Promise<string | undefined> {
		const manifest = await this.fileCache.read(
			path.join(this.sessionsDir, sessionId, `${sessionId}.json`),
			parseSessionManifestTitle,
		)
		return manifest?.value
	}
}
