import type { HistoryItem } from "@shared/HistoryItem"

/** Threads at the top of the list that keep every field; older ones are compacted. */
export const FULL_DETAIL_THREAD_COUNT = 100
/** First-message length kept on compacted rows (enough for the inbox title and search). */
const COMPACT_TASK_LENGTH = 500

/**
 * Older rows only need what the inbox and pickers read. Dropping the per-mode
 * model selection and clipping the first message keeps a very long history
 * from bloating every state push.
 */
export function compactHistoryItem(item: HistoryItem): HistoryItem {
	const { apiSelection: _apiSelection, conversationHistoryDeletedRange: _range, ...rest } = item
	return item.task.length > COMPACT_TASK_LENGTH ? { ...rest, task: item.task.slice(0, COMPACT_TASK_LENGTH) } : rest
}

/**
 * History the webview receives. Every thread the History page lists must also reach the inbox, so
 * root threads are never dropped (this used to cut the list at 100, hiding older threads from the
 * inbox while History, which pages, still listed them). Past the first `fullCount` roots, rows are
 * compacted instead. Subagent rows ride along only with a root that is in the list.
 *
 * `sorted` is newest first and already filtered to rows with a timestamp and task. `alwaysFull`
 * ids (the focused thread and its parent) keep every field.
 */
export function buildStateTaskHistory(
	sorted: readonly HistoryItem[],
	alwaysFull: readonly (string | undefined)[] = [],
	fullCount = FULL_DETAIL_THREAD_COUNT,
): HistoryItem[] {
	const byId = new Map(sorted.map((item) => [item.id, item]))
	const roots = sorted.filter((item) => !item.isSubagent)
	const rootIds = new Set(roots.map((item) => item.id))
	// A focused subagent is not a root, but navigation back to it needs its row.
	for (const id of alwaysFull) {
		const item = id ? byId.get(id) : undefined
		if (item && !item.isSubagent && !rootIds.has(item.id)) {
			roots.push(item)
			rootIds.add(item.id)
		}
	}
	// Keep the full child tree so navigation and inbox counts survive nested spawns.
	const parentIds = new Set(rootIds)
	let addedChild = true
	while (addedChild) {
		addedChild = false
		for (const item of sorted) {
			if (item.isSubagent && parentIds.has(item.parentTaskId ?? "") && !parentIds.has(item.id)) {
				parentIds.add(item.id)
				addedChild = true
			}
		}
	}
	const full = new Set([...roots.slice(0, fullCount).map((item) => item.id), ...alwaysFull.filter((id): id is string => !!id)])
	const children = sorted.filter((item) => item.isSubagent && parentIds.has(item.id))
	return [...roots, ...children].map((item) => (full.has(item.id) || item.isSubagent ? item : compactHistoryItem(item)))
}
