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
	/**
	 * When the user last messaged the thread or one of its asides: home orders by this, so the
	 * agent finishing work doesn't move a thread up. Older threads without the stamp use `ts`.
	 */
	activityTs: number
	/** Last activity of any kind (the agent's included), across asides and subagents. */
	agentActivityTs: number
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
	/** Newest member message from the user; the group's own update time when it has no threads. */
	activityTs: number
	/** Newest member activity of any kind (the agent's included). */
	agentActivityTs: number
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
	stashed: InboxEntry[]
	stashedTotal: number
	stashedNeedingYou: number
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
		stashedLimit = DEFAULT_SETTLED_LIMIT,
		taskGroups = [],
	}: { activeLimit?: number; settledLimit?: number; stashedLimit?: number; taskGroups?: readonly TaskGroupSummary[] } = {},
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
			// Activity counts every descendant (asides, asides of asides, subagents), so a busy
			// subthread keeps the parent fresh; the user's own messages only come from asides.
			let agentActivityTs = item.ts
			let activityTs = userMessageTs(item)
			const visited = new Set([item.id])
			const descendants = [...allChildren]
			for (const child of descendants) {
				if (visited.has(child.id)) continue
				visited.add(child.id)
				if (child.ts > agentActivityTs) agentActivityTs = child.ts
				if (!child.isSubagent && userMessageTs(child) > activityTs) activityTs = userMessageTs(child)
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
				agentActivityTs,
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
				agentActivityTs: Math.max(group.updatedAt, ...byActivity.map((member) => member.agentActivityTs)),
				runningCount: byActivity.filter(isRowWorking).length,
			}
		})
		.sort((a, b) => b.activityTs - a.activityTs)

	const isGroupSettled = (row: InboxTaskGroupRow) => row.members.every((member) => member.settled && !isRowWorking(member))
	const isGroupStashed = (row: InboxTaskGroupRow) => {
		const members = valid.filter((item) => !item.isSubagent && item.taskGroupId === row.group.id)
		return members.length > 0 && members.every((item) => item.isStashed)
	}
	const groups = allGroups.filter((row) => !isGroupStashed(row) && !isGroupSettled(row))
	const stashed: InboxEntry[] = [
		...unfiled.filter((row) => row.item.isStashed).map((row) => ({ kind: "thread" as const, row })),
		...allGroups.filter(isGroupStashed).map((row) => ({ kind: "group" as const, row })),
	].sort((a, b) => b.row.activityTs - a.row.activityTs)

	const active = unfiled.filter((row) => !row.item.isStashed && !row.settled).sort((a, b) => b.activityTs - a.activityTs)
	const settledTs = (entry: InboxSettledEntry) => (entry.kind === "thread" ? entry.row.item.ts : entry.row.activityTs)
	const settled: InboxSettledEntry[] = [
		...unfiled.filter((row) => !row.item.isStashed && row.settled).map((row) => ({ kind: "thread" as const, row })),
		...allGroups.filter((row) => !isGroupStashed(row) && isGroupSettled(row)).map((row) => ({ kind: "group" as const, row })),
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
		stashed: stashed.slice(0, stashedLimit),
		stashedTotal: stashed.length,
		stashedNeedingYou: valid.filter(
			(item) => !item.isSubagent && item.isStashed && statusFor(statuses, item.id) === "waiting",
		).length,
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

/** When the user last messaged a thread; threads from before the stamp existed use their last activity. */
const userMessageTs = (item: HistoryItem) => item.lastUserMessageTs ?? item.ts

/** The agent's activity after the user's last message is worth showing once it's a minute newer. */
const AGENT_LATER_MS = 60_000

/** How long ago the agent was last active, when that's after the user's last message ("2m"), else undefined. */
export function agentLaterAge(row: Pick<InboxRow, "activityTs" | "agentActivityTs">, now: number): string | undefined {
	if (row.agentActivityTs - row.activityTs < AGENT_LATER_MS) return undefined
	return formatAge(row.agentActivityTs, now)
}

/** "Your last message 5m ago · agent 2m ago": the time slot's tooltip. */
export function activityTitle(row: Pick<InboxRow, "activityTs" | "agentActivityTs">, now: number): string {
	const ago = (age: string) => (age === "now" ? "just now" : `${age} ago`)
	const later = agentLaterAge(row, now)
	return [`Your last message ${ago(formatAge(row.activityTs, now))}`, later && `agent ${ago(later)}`]
		.filter(Boolean)
		.join(" · ")
}

/** Second line of an inbox row. */
export function describeActivity(row: InboxRow, now: number): string {
	if (row.settled) {
		const age = formatAge(row.agentActivityTs, now)
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
	const later = agentLaterAge(row, now)
	return [
		row.item.modelId ? `Done · ${row.item.modelId}` : "Done",
		later && (later === "now" ? "agent replied just now" : `agent replied ${later} ago`),
	]
		.filter(Boolean)
		.join(" · ")
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
