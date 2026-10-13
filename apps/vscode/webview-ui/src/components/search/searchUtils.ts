import type { HistoryItem } from "@shared/HistoryItem"
import type { SearchHistoryResult } from "@shared/proto/cline/task_group"
import type { TaskGroupSummary, TaskTag } from "@shared/task-groups"
import Fuse from "fuse.js"

export type SearchResultKind = "task" | "thread" | "note" | "message"
export type SearchFilter = "all" | "tasks" | "threads" | "notes" | "messages"

export const SEARCH_FILTERS: { filter: SearchFilter; label: string; kind?: SearchResultKind }[] = [
	{ filter: "all", label: "All" },
	{ filter: "tasks", label: "Tasks", kind: "task" },
	{ filter: "threads", label: "Threads", kind: "thread" },
	{ filter: "notes", label: "Notes", kind: "note" },
	{ filter: "messages", label: "Messages", kind: "message" },
]

export interface SearchRow {
	kind: SearchResultKind
	/** Task group id, thread id, note slug or message id (per `kind`). */
	id: string
	title: string
	snippet?: string
	ts: number
	tags?: TaskTag[]
	taskGroupId?: string
	/** The thread to open for message rows. */
	threadId?: string
	/** 0 = best match, 1 = worst (Fuse scale). */
	score: number
}

// Server matches are exact substrings in bodies. They rank below a close title
// or tag match but above a loose fuzzy one; ties go to the newest.
const SERVER_SCORE: Record<SearchResultKind, number> = { task: 0.2, thread: 0.2, note: 0.25, message: 0.35 }
// Note hits arrive already ranked (name/description before body, each bucket
// newest-first). A tiny per-ordinal step preserves that order through the
// score-then-recency sort while staying well below the message score — the
// server caps results, so the total drift stays under 0.03.
const NOTE_RANK_STEP = 1e-4

// Tight enough that the list doesn't fill with one-letter coincidences.
const FUSE_OPTIONS = {
	threshold: 0.4,
	ignoreLocation: true,
	includeScore: true,
	isCaseSensitive: false,
	minMatchCharLength: 1,
} as const

const titleOf = (item: HistoryItem) => item.title?.trim() || item.task

/** Fuzzy search over task titles + tags and thread titles + first message + tags. */
export function searchLocal(query: string, taskGroups: TaskGroupSummary[], history: HistoryItem[]): SearchRow[] {
	const trimmed = query.trim()
	if (!trimmed) return []

	const taskFuse = new Fuse(taskGroups, { ...FUSE_OPTIONS, keys: ["title", "tags.value"] })
	const tasks = taskFuse.search(trimmed).map(
		({ item, score }): SearchRow => ({
			kind: "task",
			id: item.id,
			title: item.title,
			ts: item.updatedAt,
			tags: item.tags,
			taskGroupId: item.id,
			score: score ?? 1,
		}),
	)

	// Subagents open through their parent; only user-facing threads are listed.
	const threads = history.filter((item) => !item.isSubagent)
	const threadFuse = new Fuse(threads, {
		...FUSE_OPTIONS,
		keys: [
			{ name: "title", weight: 2 },
			{ name: "task", weight: 1 },
			{ name: "tags.value", weight: 2 },
		],
	})
	const threadRows = threadFuse.search(trimmed).map(
		({ item, score }): SearchRow => ({
			kind: "thread",
			id: item.id,
			title: titleOf(item),
			ts: item.lastActivityTs ?? item.ts,
			tags: item.tags,
			taskGroupId: item.taskGroupId || undefined,
			threadId: item.id,
			score: score ?? 1,
		}),
	)

	return [...tasks, ...threadRows]
}

/** Converts `searchHistory` results into rows. */
export function fromServerResults(results: SearchHistoryResult[]): SearchRow[] {
	let noteRank = 0
	return results.flatMap((result): SearchRow[] => {
		const kind = result.kind as SearchResultKind
		if (!(kind in SERVER_SCORE) || !result.id) return []
		return [
			{
				kind,
				id: result.id,
				title: result.title,
				snippet: result.snippet || undefined,
				ts: Number(result.ts) || 0,
				taskGroupId: result.taskGroupId || undefined,
				threadId: result.threadId || undefined,
				score: kind === "note" ? SERVER_SCORE.note + noteRank++ * NOTE_RANK_STEP : SERVER_SCORE[kind],
			},
		]
	})
}

/** One ranked list: local rows win on duplicates (they carry tags and a real score); best score first, then newest. */
export function mergeResults(local: SearchRow[], server: SearchRow[]): SearchRow[] {
	const seen = new Set<string>()
	const merged: SearchRow[] = []
	for (const row of [...local, ...server]) {
		// Note slugs are only unique within their task.
		const key = row.kind === "note" ? `note:${row.taskGroupId ?? ""}:${row.id}` : `${row.kind}:${row.id}`
		if (seen.has(key)) continue
		seen.add(key)
		merged.push(row)
	}
	return merged.sort((a, b) => a.score - b.score || b.ts - a.ts)
}

export function countByKind(rows: SearchRow[]): Record<SearchResultKind, number> {
	const counts: Record<SearchResultKind, number> = { task: 0, thread: 0, note: 0, message: 0 }
	for (const row of rows) counts[row.kind]++
	return counts
}

export function filterRows(rows: SearchRow[], filter: SearchFilter): SearchRow[] {
	const kind = SEARCH_FILTERS.find((entry) => entry.filter === filter)?.kind
	return kind ? rows.filter((row) => row.kind === kind) : rows
}

const tagKey = (tag: TaskTag) => `${tag.kind}:${tag.value.toLowerCase()}`

/** The task a loose thread could join: the most recently updated task sharing one of its tags. */
export function suggestTaskGroup(
	threadTags: TaskTag[] | undefined,
	taskGroups: TaskGroupSummary[],
): TaskGroupSummary | undefined {
	if (!threadTags?.length) return undefined
	const keys = new Set(threadTags.map(tagKey))
	return [...taskGroups]
		.sort((a, b) => b.updatedAt - a.updatedAt)
		.find((group) => group.tags.some((tag) => keys.has(tagKey(tag))))
}
