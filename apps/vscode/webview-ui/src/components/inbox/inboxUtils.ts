import type { ExtensionState } from "@shared/ExtensionMessage"
import type { HistoryItem } from "@shared/HistoryItem"
import type { TaskGroupSummary } from "@shared/task-groups"
import { deriveThreadStatus, isLiveThreadStatus, type ThreadStatus, waitingOnLabel } from "./threadStatus"

export type SessionStatus = ExtensionState["sessionStatuses"][string]
export type SessionStatuses = ExtensionState["sessionStatuses"]
export type SubagentCounts = ExtensionState["subagentCounts"]

export const DEFAULT_ACTIVE_LIMIT = 15
export const DEFAULT_SETTLED_LIMIT = 10
/** How many more settled rows each "Show more" reveals. */
export const SETTLED_PAGE_SIZE = 25
/** How many more active rows each "Show more" reveals. */
export const ACTIVE_PAGE_SIZE = 25

export interface InboxRow {
	item: HistoryItem
	/** Effective last-active time: the item's ts or the newest descendant's (asides and subagents). */
	activityTs: number
	/** Derived: "subagents" when the thread is idle but its subagents or subthreads still run. */
	status: ThreadStatus
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
	/** Member thread rows: active ones first, then settled ones, each newest activity first. */
	members: InboxRow[]
	/** Newest member activity; the group's own update time when it has no threads. */
	activityTs: number
	/** Members with work in progress (the thread itself or one of its subthreads/subagents). */
	runningCount: number
}

/** A row in the Settled section: a settled thread, or a task whose threads are all settled (or has none). */
export type InboxSettledEntry = { kind: "thread"; row: InboxRow } | { kind: "group"; row: InboxTaskGroupRow }

/** A row in either inbox section: a thread or a task. */
export type InboxEntry = InboxSettledEntry

export interface InboxGroups {
	/** Task groups with unsettled threads, newest activity first. */
	groups: InboxTaskGroupRow[]
	active: InboxRow[]
	/** Active tasks and threads interleaved by last activity, as the Active section shows them. */
	activeEntries: InboxEntry[]
	/** Settled threads and settled tasks, newest activity first. */
	settled: InboxSettledEntry[]
	/** All settled entries, including those cut by the settled limit. */
	settledTotal: number
	/** Active rows past the active limit; the list offers "Show more" for them. */
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
	return row.status === "running" || row.status === "subagents" || row.liveSubthreadCount > 0 || row.liveSubagentCount > 0
}

/**
 * Groups task history for the home inbox. Asides are folded into their parent's
 * subthread count instead of being top-level rows (unless the parent is gone).
 * An aside always belongs to its parent's task, so it never differs in grouping.
 * Threads filed into a known task group move under that group's row. A group
 * is active while any member has unsettled or in-progress work; groups whose
 * members are all settled (or that have none) sit in the settled list.
 * Active (unsettled) rows sort by last activity including subthreads; settled
 * rows by their own last activity; groups by their newest member (or their own
 * update time when empty).
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
	// Asides and subagents always nest under their parent: an aside belongs to its parent's
	// task (the extension keeps them in step), so it never needs a row of its own.
	// Legacy or hand-edited history can point a thread at itself or loop parents; nesting those
	// would remove every thread in the loop from the list, so they stay top-level.
	const inParentLoop = (item: HistoryItem): boolean => {
		const seen = new Set([item.id])
		for (let parentId = item.parentTaskId; parentId; parentId = byId.get(parentId)?.parentTaskId) {
			if (seen.has(parentId)) return true
			seen.add(parentId)
		}
		return false
	}
	const nests = (item: HistoryItem): boolean => {
		const parent = item.parentTaskId ? byId.get(item.parentTaskId) : undefined
		if (!parent || inParentLoop(item)) return false
		return true
	}
	// A subthread whose parent is gone has nowhere to roll up into: it is listed on its own, settled.
	const isOrphan = (item: HistoryItem): boolean => !!item.parentTaskId && !byId.has(item.parentTaskId)
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
			const ownStatus = statusFor(statuses, item.id)
			const liveSubthreadCount = children.filter((child) => statusFor(statuses, child.id) === "running").length
			// Live sessions report total+live; otherwise fall back to the persisted total.
			const liveSubagentCount = Math.max(
				counts?.live ?? 0,
				agents.filter((child) => isLive(statusFor(statuses, child.id))).length,
			)
			const attentionSubagentCount = agents.filter((child) => statusFor(statuses, child.id) === "waiting").length
			const status = deriveThreadStatus(ownStatus, {
				liveSubagents: liveSubagentCount,
				liveSubthreads: liveSubthreadCount,
				attentionSubagents: attentionSubagentCount,
			})
			return {
				item,
				activityTs,
				status,
				// A live thread (including one waiting on subagents) is never shown as settled, even if the history flag lags.
				settled: (!!item.isSettled || isOrphan(item)) && !isLiveThreadStatus(status),
				subthreadCount: children.length,
				liveSubthreadCount,
				subagentCount: Math.max(counts?.total ?? item.subagentCount ?? 0, agents.length),
				liveSubagentCount,
				attentionSubagentCount,
			}
		})

	const membersByGroup = new Map<string, InboxRow[]>(taskGroups.map((group) => [group.id, []]))
	const unfiled: InboxRow[] = []
	for (const row of rows) {
		const members = row.item.taskGroupId ? membersByGroup.get(row.item.taskGroupId) : undefined
		if (members) members.push(row)
		else unfiled.push(row)
	}
	const allGroups = taskGroups
		.map((group) => {
			const byActivity = (membersByGroup.get(group.id) ?? []).sort((a, b) => b.activityTs - a.activityTs)
			const isActive = (member: InboxRow) => !member.settled || isRowWorking(member)
			return {
				group,
				members: [...byActivity.filter(isActive), ...byActivity.filter((member) => !isActive(member))],
				activityTs: byActivity[0]?.activityTs ?? group.updatedAt,
				runningCount: byActivity.filter(isRowWorking).length,
			}
		})
		.sort((a, b) => b.activityTs - a.activityTs)

	const isGroupSettled = (row: InboxTaskGroupRow) => row.members.every((member) => member.settled && !isRowWorking(member))
	const groups = allGroups.filter((row) => !isGroupSettled(row))

	const active = unfiled.filter((row) => !row.settled).sort((a, b) => b.activityTs - a.activityTs)
	const settledTs = (entry: InboxSettledEntry) => (entry.kind === "thread" ? entry.row.item.ts : entry.row.activityTs)
	const settled: InboxSettledEntry[] = [
		...unfiled.filter((row) => row.settled).map((row) => ({ kind: "thread" as const, row })),
		...allGroups.filter(isGroupSettled).map((row) => ({ kind: "group" as const, row })),
	].sort((a, b) => settledTs(b) - settledTs(a))

	const shownActive = active.slice(0, activeLimit)
	const activeEntries: InboxEntry[] = [
		...groups.map((row) => ({ kind: "group" as const, row })),
		...shownActive.map((row) => ({ kind: "thread" as const, row })),
	].sort((a, b) => b.row.activityTs - a.row.activityTs)

	return {
		groups,
		active: shownActive,
		activeEntries,
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
		case "stopped":
			return "Stopped"
		case "subagents":
			return waitingOnLabel(row.liveSubagentCount, row.liveSubthreadCount)
	}
	return row.item.modelId ? `Done · ${row.item.modelId}` : "Done"
}

/** Member threads an expanded group row shows before "Show N more". */
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
