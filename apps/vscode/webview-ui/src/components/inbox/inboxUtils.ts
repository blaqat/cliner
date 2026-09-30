import type { ExtensionState } from "@shared/ExtensionMessage"
import type { HistoryItem } from "@shared/HistoryItem"

export type SessionStatus = ExtensionState["sessionStatuses"][string]
export type SessionStatuses = ExtensionState["sessionStatuses"]
export type SubagentCounts = ExtensionState["subagentCounts"]

export const DEFAULT_ACTIVE_LIMIT = 15
export const DEFAULT_SETTLED_LIMIT = 10
/** How many more settled rows each "Show more" reveals. */
export const SETTLED_PAGE_SIZE = 25

export interface InboxRow {
	item: HistoryItem
	status: SessionStatus
	settled: boolean
	/** Asides forked from this task (history items whose parentTaskId is this task). */
	subthreadCount: number
	/** Asides that are currently running. */
	liveSubthreadCount: number
	/** Total subagents the task has spawned (live count or persisted total). */
	subagentCount: number
	/** Subagents still running. */
	liveSubagentCount: number
}

export interface InboxGroups {
	active: InboxRow[]
	settled: InboxRow[]
	/** All settled chats, including those cut by the settled limit. */
	settledTotal: number
	/** Active rows cut by the active limit; the list links to the full history when non-zero. */
	hiddenCount: number
}

export function statusFor(statuses: SessionStatuses | undefined, id: string): SessionStatus {
	return statuses?.[id] ?? "done"
}

function isLive(status: SessionStatus): boolean {
	return status === "running" || status === "waiting"
}

/**
 * Groups task history for the home inbox. Asides are folded into their parent's
 * subthread count instead of being top-level rows (unless the parent is gone).
 * Active (unsettled) rows sort by recency; settled rows by when they were settled.
 */
export function buildInbox(
	history: readonly HistoryItem[],
	statuses: SessionStatuses | undefined,
	subagentCounts?: SubagentCounts,
	{ activeLimit = DEFAULT_ACTIVE_LIMIT, settledLimit = DEFAULT_SETTLED_LIMIT } = {},
): InboxGroups {
	const valid = history.filter((item) => item.ts && item.task)
	const ids = new Set(valid.map((item) => item.id))
	const childrenByParent = new Map<string, HistoryItem[]>()
	for (const item of valid) {
		if (item.parentTaskId && ids.has(item.parentTaskId)) {
			const siblings = childrenByParent.get(item.parentTaskId) ?? []
			siblings.push(item)
			childrenByParent.set(item.parentTaskId, siblings)
		}
	}

	const rows: InboxRow[] = valid
		.filter((item) => !item.parentTaskId || !ids.has(item.parentTaskId))
		.map((item) => {
			const children = childrenByParent.get(item.id) ?? []
			const counts = subagentCounts?.[item.id]
			return {
				item,
				status: statusFor(statuses, item.id),
				// A live session is never shown as settled, even if the history flag lags.
				settled: !!item.isSettled && !isLive(statusFor(statuses, item.id)),
				subthreadCount: children.length,
				liveSubthreadCount: children.filter((child) => statusFor(statuses, child.id) === "running").length,
				// Live sessions report total+live; otherwise fall back to the persisted total.
				subagentCount: counts?.total ?? item.subagentCount ?? 0,
				liveSubagentCount: counts?.live ?? 0,
			}
		})

	const active = rows.filter((row) => !row.settled).sort((a, b) => b.item.ts - a.item.ts)
	const settled = rows
		.filter((row) => row.settled)
		.sort((a, b) => (b.item.settledAt ?? b.item.ts) - (a.item.settledAt ?? a.item.ts))

	return {
		active: active.slice(0, activeLimit),
		settled: settled.slice(0, settledLimit),
		settledTotal: settled.length,
		hiddenCount: Math.max(0, active.length - activeLimit),
	}
}

/** Number of tasks other than `focusedId` that are running in the background. */
export function countBackgroundRunning(statuses: SessionStatuses | undefined, focusedId: string | undefined): number {
	return Object.entries(statuses ?? {}).filter(([id, status]) => id !== focusedId && status === "running").length
}

/** Compact relative age: "now", "5m", "3h", "2d". */
export function formatAge(ts: number, now: number): string {
	const minutes = Math.floor((now - ts) / 60_000)
	if (minutes < 1) {
		return "now"
	}
	if (minutes < 60) {
		return `${minutes}m`
	}
	const hours = Math.floor(minutes / 60)
	return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`
}

/** Settled timestamp: time of day when today, otherwise a short date. */
export function formatStamp(ts: number, now: number): string {
	const date = new Date(ts)
	const today = new Date(now)
	if (date.toDateString() === today.toDateString()) {
		return date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
	}
	return date.toLocaleDateString("en-US", { month: "short", day: "numeric" })
}

/** Second line of an inbox row. */
export function describeActivity(row: InboxRow, now: number): string {
	if (row.settled) {
		const age = formatAge(row.item.settledAt ?? row.item.ts, now)
		return age === "now" ? "Settled just now" : `Settled ${age} ago`
	}
	switch (row.status) {
		case "running":
			return "Working…"
		case "waiting":
			return "Waiting for you"
		case "error":
			return "Stopped with an error"
		default:
			return row.item.modelId ? `Done · ${row.item.modelId}` : "Done"
	}
}
