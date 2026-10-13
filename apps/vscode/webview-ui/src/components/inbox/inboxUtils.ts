import type { ExtensionState } from "@shared/ExtensionMessage"
import type { HistoryItem } from "@shared/HistoryItem"
import type { TaskGroupSummary } from "@shared/task-groups"

export type SessionStatus = ExtensionState["sessionStatuses"][string]
export type SessionStatuses = ExtensionState["sessionStatuses"]
export type SubagentCounts = ExtensionState["subagentCounts"]

export const DEFAULT_ACTIVE_LIMIT = 15
export const DEFAULT_SETTLED_LIMIT = 10
/** How many more settled rows each "Show more" reveals. */
export const SETTLED_PAGE_SIZE = 25

export interface InboxRow {
	item: HistoryItem
	/** Effective last-active time: the item's ts or the newest descendant's (asides and subagents). */
	activityTs: number
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
	/** Subagents waiting on the user (approval or question). */
	attentionSubagentCount: number
}

/** A task group ("Task" in the UI) row: its member threads leave the top level. */
export interface InboxTaskGroupRow {
	group: TaskGroupSummary
	/** Member thread rows (settled included), newest activity first. */
	members: InboxRow[]
	/** Newest member activity; the group's own update time when it has no threads. */
	activityTs: number
	/** Members with work in progress (the thread itself or one of its subthreads/subagents). */
	runningCount: number
}

export interface InboxGroups {
	/** Task groups, newest activity first. Shown above the unfiled active rows. */
	groups: InboxTaskGroupRow[]
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

/** The thread or one of its subthreads/subagents is working right now. */
export function isRowWorking(row: InboxRow): boolean {
	return row.status === "running" || row.liveSubthreadCount > 0 || row.liveSubagentCount > 0
}

/**
 * Groups task history for the home inbox. Asides are folded into their parent's
 * subthread count instead of being top-level rows (unless the parent is gone or
 * the aside is filed in a different task than the parent).
 * Threads filed into a known task group move under that group's row.
 * Active (unsettled) rows sort by last activity including subthreads; settled
 * rows by their own last activity; groups by their newest member.
 */
export function buildInbox(
	history: readonly HistoryItem[],
	statuses: SessionStatuses | undefined,
	subagentCounts?: SubagentCounts,
	{
		activeLimit = DEFAULT_ACTIVE_LIMIT,
		settledLimit = DEFAULT_SETTLED_LIMIT,
		taskGroups = [],
	}: { activeLimit?: number; settledLimit?: number; taskGroups?: readonly TaskGroupSummary[] } = {},
): InboxGroups {
	const valid = history.filter((item) => item.ts && item.task)
	const byId = new Map(valid.map((item) => [item.id, item]))
	// Asides own their task membership. One moved to another task (or out of its
	// parent's) is listed as its own row there instead of under the parent, so it
	// shows wherever its breadcrumb says it lives. Subagents always nest.
	const nests = (item: HistoryItem): boolean => {
		const parent = item.parentTaskId ? byId.get(item.parentTaskId) : undefined
		if (!parent) return false
		return !!item.isSubagent || (item.taskGroupId || undefined) === (parent.taskGroupId || undefined)
	}
	const childrenByParent = new Map<string, HistoryItem[]>()
	for (const item of valid) {
		if (item.parentTaskId && nests(item)) {
			const siblings = childrenByParent.get(item.parentTaskId) ?? []
			siblings.push(item)
			childrenByParent.set(item.parentTaskId, siblings)
		}
	}

	const rows: InboxRow[] = valid
		.filter((item) => !nests(item))
		.map((item) => {
			const allChildren = childrenByParent.get(item.id) ?? []
			const children = allChildren.filter((child) => !child.isSubagent)
			const agents: HistoryItem[] = []
			const seen = new Set([item.id])
			const pending = allChildren.filter((child) => child.isSubagent)
			for (const child of pending) {
				if (seen.has(child.id)) continue
				seen.add(child.id)
				agents.push(child)
				pending.push(...(childrenByParent.get(child.id) ?? []).filter((nested) => nested.isSubagent))
			}
			// Last active counts every descendant — asides, asides of asides, and
			// subagents — so a busy subthread keeps the parent fresh.
			let activityTs = item.ts
			const visited = new Set([item.id])
			const descendants = [...allChildren]
			for (const child of descendants) {
				if (visited.has(child.id)) continue
				visited.add(child.id)
				if (child.ts > activityTs) activityTs = child.ts
				descendants.push(...(childrenByParent.get(child.id) ?? []))
			}
			const counts = subagentCounts?.[item.id]
			return {
				item,
				activityTs,
				status: statusFor(statuses, item.id),
				// A live session is never shown as settled, even if the history flag lags.
				settled: !!item.isSettled && !isLive(statusFor(statuses, item.id)),
				subthreadCount: children.length,
				liveSubthreadCount: children.filter((child) => statusFor(statuses, child.id) === "running").length,
				// Live sessions report total+live; otherwise fall back to the persisted total.
				subagentCount: Math.max(counts?.total ?? item.subagentCount ?? 0, agents.length),
				liveSubagentCount: Math.max(
					counts?.live ?? 0,
					agents.filter((child) => isLive(statusFor(statuses, child.id))).length,
				),
				attentionSubagentCount: agents.filter((child) => statusFor(statuses, child.id) === "waiting").length,
			}
		})

	const membersByGroup = new Map<string, InboxRow[]>(taskGroups.map((group) => [group.id, []]))
	const unfiled: InboxRow[] = []
	for (const row of rows) {
		const members = row.item.taskGroupId ? membersByGroup.get(row.item.taskGroupId) : undefined
		if (members) members.push(row)
		else unfiled.push(row)
	}
	const groups = taskGroups
		.map((group) => {
			const members = (membersByGroup.get(group.id) ?? []).sort((a, b) => b.activityTs - a.activityTs)
			return {
				group,
				members,
				activityTs: members[0]?.activityTs ?? group.updatedAt,
				runningCount: members.filter(isRowWorking).length,
			}
		})
		.sort((a, b) => b.activityTs - a.activityTs)

	const active = unfiled.filter((row) => !row.settled).sort((a, b) => b.activityTs - a.activityTs)
	const settled = unfiled.filter((row) => row.settled).sort((a, b) => b.item.ts - a.item.ts)

	return {
		groups,
		active: active.slice(0, activeLimit),
		settled: settled.slice(0, settledLimit),
		settledTotal: settled.length,
		hiddenCount: Math.max(0, active.length - activeLimit),
	}
}

/** Number of tasks other than `focusedId` that are running in the background. */
export function countBackgroundRunning(
	statuses: SessionStatuses | undefined,
	focusedId: string | undefined,
	history: readonly HistoryItem[] = [],
): number {
	const childIds = new Set(history.filter((item) => item.isSubagent).map((item) => item.id))
	return Object.entries(statuses ?? {}).filter(([id, status]) => id !== focusedId && !childIds.has(id) && status === "running")
		.length
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

/** Last-activity timestamp: time of day when today, otherwise a short date. */
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
		const age = formatAge(row.activityTs, now)
		return age === "now" ? "Last active just now" : `Last active ${age} ago`
	}
	switch (row.status) {
		case "running":
			return "Working…"
		case "waiting":
			return "Waiting for you"
		case "error":
			return "Stopped with an error"
	}
	// An idle parent with a busy subthread still has work happening.
	if (row.liveSubthreadCount > 0 || row.liveSubagentCount > 0) return "Working… in subthread"
	return row.item.modelId ? `Done · ${row.item.modelId}` : "Done"
}

/** Member threads an expanded group row shows; the rest collapse into "＋N older". */
export const GROUP_PREVIEW_COUNT = 2

const EXPANDED_TASK_GROUPS_KEY = "inbox.expandedTaskGroups"
/** Fired on window when another component expands a group (e.g. right after creating it). */
export const EXPANDED_TASK_GROUPS_EVENT = "inbox:expandedTaskGroups"

/** Task groups the user expanded on home. Groups start collapsed. */
export function readExpandedTaskGroups(): Set<string> {
	try {
		const ids: unknown = JSON.parse(localStorage.getItem(EXPANDED_TASK_GROUPS_KEY) ?? "[]")
		return new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [])
	} catch {
		return new Set()
	}
}

export function writeExpandedTaskGroups(ids: ReadonlySet<string>): void {
	try {
		localStorage.setItem(EXPANDED_TASK_GROUPS_KEY, JSON.stringify([...ids]))
	} catch {
		// Persistence is best-effort; the toggle still works for this session.
	}
}

/** Expands a group row on home (persisted) and tells a mounted inbox to pick it up. */
export function expandTaskGroupInInbox(id: string): void {
	writeExpandedTaskGroups(new Set([...readExpandedTaskGroups(), id]))
	window.dispatchEvent(new Event(EXPANDED_TASK_GROUPS_EVENT))
}
