import type { HistoryItem } from "@shared/HistoryItem"
import { GetTaskHistoryRequest } from "@shared/proto/cline/task"
import { useEffect, useMemo, useRef, useState } from "react"
import { TaskServiceClient } from "@/services/grpc-client"

export interface ThreadMentionOption {
	id: string
	/** Display title — user-set thread title, else the first message. */
	title: string
	/** Owning task group's title, when the thread is filed under one. */
	taskGroupTitle?: string
	ts?: number
	isCurrentThread?: boolean
}

/**
 * Finds `thread:<query>` immediately before the caret — like findNoteMention,
 * the prefix can't touch a word char or `/ @ # .` so `a/b/thread:x` or a
 * pasted link don't trigger the menu.
 */
export function findThreadMention(text: string, cursor: number): { start: number; query: string } | undefined {
	const match = /(^|[^\w/@#.])thread:([^\s]*)$/.exec(text.slice(0, cursor))
	if (!match) return undefined
	return { start: match.index + match[1].length, query: match[2] }
}

/** Replaces the `thread:query` ending at `cursor` with `thread:<id> `. */
export function insertThreadMention(
	text: string,
	cursor: number,
	start: number,
	threadId: string,
): { value: string; cursor: number } {
	const inserted = `thread:${threadId} `
	const rest = text.slice(cursor).replace(/^ /, "")
	return { value: text.slice(0, start) + inserted + rest, cursor: start + inserted.length }
}

function toOption(item: HistoryItem, currentThreadId?: string): ThreadMentionOption {
	return {
		id: item.id,
		title: item.title || item.task,
		ts: item.lastActivityTs || item.ts,
		isCurrentThread: item.id === currentThreadId,
	}
}

/** Case-insensitive fuzzy-ish match on title/task/id, most recent first. */
export function matchThreads(threads: ThreadMentionOption[], query: string, limit = 8): ThreadMentionOption[] {
	const q = query.trim().toLowerCase()
	const scored = threads
		.filter((t) => !t.isCurrentThread)
		.map((t) => {
			if (!q) {
				return { t, rank: 0 }
			}
			const title = t.title.toLowerCase()
			const id = t.id.toLowerCase()
			const group = (t.taskGroupTitle ?? "").toLowerCase()
			if (title.startsWith(q)) return { t, rank: 0 }
			if (title.includes(q) || id.includes(q)) return { t, rank: 1 }
			if (group.includes(q)) return { t, rank: 2 }
			// subsequence match — fuzzy like the file picker's @ menu
			let i = 0
			for (const ch of title) {
				if (ch === q[i]) i++
			}
			return i === q.length ? { t, rank: 3 } : null
		})
		.filter((s): s is { t: ThreadMentionOption; rank: number } => s !== null)
	scored.sort((a, b) => a.rank - b.rank || (b.t.ts ?? 0) - (a.t.ts ?? 0))
	return scored.map((s) => s.t).slice(0, limit)
}

/**
 * Threads for the `thread:` mention menu. Local fuzzy match over the loaded
 * history (covers subagents and the freshest items), plus a server-side
 * history search for older threads beyond the loaded window.
 */
export function useThreadMentionMatches(
	history: readonly HistoryItem[] | undefined,
	taskGroupTitleById: ReadonlyMap<string, string>,
	currentThreadId: string | undefined,
	query: string | null,
): ThreadMentionOption[] {
	const local = useMemo(
		() =>
			(history ?? [])
				.filter((item) => !item.isSubagent)
				.map((item) => ({
					...toOption(item, currentThreadId),
					taskGroupTitle: item.taskGroupId ? taskGroupTitleById.get(item.taskGroupId) : undefined,
				})),
		[history, taskGroupTitleById, currentThreadId],
	)
	const [remote, setRemote] = useState<ThreadMentionOption[]>([])
	const seq = useRef(0)

	useEffect(() => {
		if (query === null || !query.trim()) {
			setRemote([])
			return
		}
		const mySeq = ++seq.current
		const timer = setTimeout(() => {
			TaskServiceClient.getTaskHistory(GetTaskHistoryRequest.create({ searchQuery: query.trim(), limit: 8 }))
				.then((res) => {
					if (seq.current !== mySeq) return
					setRemote(
						(res.tasks ?? []).map((t) => ({
							id: t.id,
							title: t.title || t.task,
							ts: t.ts,
							taskGroupTitle: t.taskGroupId ? taskGroupTitleById.get(t.taskGroupId) : undefined,
							isCurrentThread: t.id === currentThreadId,
						})),
					)
				})
				.catch((err) => console.error("thread mention search failed:", err))
		}, 200)
		return () => clearTimeout(timer)
	}, [query, taskGroupTitleById, currentThreadId])

	return useMemo(() => {
		const seen = new Set<string>()
		const merged: ThreadMentionOption[] = []
		for (const opt of [...local, ...remote]) {
			if (seen.has(opt.id)) continue
			seen.add(opt.id)
			merged.push(opt)
		}
		return matchThreads(merged, query ?? "", 8)
	}, [local, remote, query])
}
