import { promises as fs } from "node:fs"
import path from "node:path"
import { formatDisplayUserInput } from "@cline/shared"
import { resolveSessionDataDir } from "@cline/shared/storage"
import { parseYamlFrontmatter } from "@core/context/instructions/user-instructions/frontmatter"
import type { HistorySearchHit, HistorySearchThread } from "@shared/task-groups"
import { Logger } from "@/shared/services/Logger"
import { NotebookStore } from "./notebook-store"
import { TaskGroupStore, taskGroupPaths, taskGroupsRootDir } from "./task-group-store"

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200
const SNIPPET_LENGTH = 120
// Characters of context shown before the match when the hit sits mid-text.
const SNIPPET_CONTEXT = 40
const MAX_CACHE_ENTRIES = 256
// Yield to the event loop every N files so a large history never monopolizes
// the extension host during a scan.
const FILES_PER_YIELD = 8

function yieldToEventLoop(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve))
}

function collapseWhitespace(input: string): string {
	return input.replace(/\s+/g, " ").trim()
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
 * each time would dominate; the bound keeps the cache from growing with the
 * number of files ever scanned (LRU eviction on insertion order).
 */
class ParsedFileCache {
	private readonly entries = new Map<string, { mtimeMs: number; size: number; value: unknown }>()

	constructor(private readonly maxEntries: number) {}

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
		try {
			value = parse(await fs.readFile(filePath, "utf8"))
		} catch (error) {
			Logger.warn(`[HistorySearcher] Failed to read ${filePath}:`, error)
		}
		this.entries.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, value })
		while (this.entries.size > this.maxEntries) {
			const oldest = this.entries.keys().next().value
			if (oldest === undefined) break
			this.entries.delete(oldest)
		}
		return { value, mtimeMs: stat.mtimeMs }
	}
}

interface SearchableMessage {
	/** Index into the session's raw `messages` array; used in the result id. */
	index: number
	ts: number
	/** Collapsed display text, plus its precomputed lowercase form. */
	text: string
	lower: string
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
		messages.push({ index, ts: typeof message.ts === "number" ? message.ts : 0, text, lower: text.toLowerCase() })
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

export interface HistorySearchOptions {
	/** Sessions root; defaults to resolveSessionDataDir(). Overridden in tests. */
	sessionsDir?: string
	/** Task-groups root; defaults to taskGroupsRootDir(). Overridden in tests. */
	taskGroupsDir?: string
	maxCacheEntries?: number
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
	private readonly notebookStore: NotebookStore
	private readonly fileCache: ParsedFileCache

	constructor(options: HistorySearchOptions = {}) {
		this.sessionsDir = options.sessionsDir ?? resolveSessionDataDir()
		this.taskGroupsDir = options.taskGroupsDir ?? taskGroupsRootDir()
		this.taskGroupStore = new TaskGroupStore(this.taskGroupsDir)
		this.notebookStore = new NotebookStore(this.taskGroupsDir)
		this.fileCache = new ParsedFileCache(options.maxCacheEntries ?? MAX_CACHE_ENTRIES)
	}

	async search(input: {
		query: string
		kind?: string
		limit?: number
		threads?: HistorySearchThread[]
	}): Promise<HistorySearchHit[]> {
		const query = collapseWhitespace(input.query).toLowerCase()
		if (!query) {
			return []
		}
		const requested = Math.floor(input.limit ?? 0)
		const limit = requested > 0 ? Math.min(requested, MAX_LIMIT) : DEFAULT_LIMIT
		const kind = input.kind ?? "all"
		const hits: HistorySearchHit[] = []
		if (kind === "all" || kind === "notes") {
			hits.push(...(await this.searchNotes(query, limit)))
		}
		if (kind === "all" || kind === "messages") {
			hits.push(...(await this.searchMessages(query, limit, input.threads)))
		}
		hits.sort((a, b) => b.ts - a.ts)
		return hits.slice(0, limit)
	}

	private async searchNotes(query: string, limit: number): Promise<HistorySearchHit[]> {
		const hits: HistorySearchHit[] = []
		let scanned = 0
		for (const group of await this.taskGroupStore.listGroups()) {
			for (const note of await this.notebookStore.listNotes(group.id)) {
				if (hits.length >= limit) return hits
				if (++scanned % FILES_PER_YIELD === 0) await yieldToEventLoop()
				const file = await this.fileCache.read(taskGroupPaths(this.taskGroupsDir, group.id).noteFile(note.slug), (raw) =>
					collapseWhitespace(parseYamlFrontmatter(raw).body),
				)
				const body = file?.value
				if (!body) continue
				const matchIndex = body.toLowerCase().indexOf(query)
				if (matchIndex === -1) continue
				hits.push({
					kind: "note",
					id: note.slug,
					title: note.name,
					snippet: searchSnippet(body, matchIndex),
					ts: note.updatedAt,
					taskGroupId: group.id,
				})
			}
		}
		return hits
	}

	private async searchMessages(query: string, limit: number, threads?: HistorySearchThread[]): Promise<HistorySearchHit[]> {
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
			if (hits.length >= limit) break
			if (++scanned % FILES_PER_YIELD === 0) await yieldToEventLoop()
			const parsed = await this.fileCache.read(file.path, parseSessionMessages)
			if (!parsed?.value) continue
			// Newest messages first, so hitting the limit mid-file keeps the most
			// recent matches.
			for (let i = parsed.value.length - 1; i >= 0 && hits.length < limit; i--) {
				const message = parsed.value[i]
				const matchIndex = message.lower.indexOf(query)
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
