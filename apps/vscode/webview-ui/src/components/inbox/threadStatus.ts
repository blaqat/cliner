import type { HistoryItem } from "@shared/HistoryItem"
import type { SessionStatus, SessionStatuses } from "./inboxUtils"

/**
 * What a thread's status dot shows. `subagents` is derived in the webview: the
 * extension reports the thread as done (its own turn ended) while subagents or
 * subthreads it started are still working.
 */
export type ThreadStatus = SessionStatus | "subagents"

/** Any status map the status rules read; raw session statuses fit too. */
export type ThreadStatusMap = Readonly<Record<string, ThreadStatus>>

export interface LiveChildren {
	/** Subagents (and their nested subagents) running or waiting on the user. */
	liveSubagents: number
	/** Subthreads (asides) running. */
	liveSubthreads: number
	/** Subagents waiting on the user (approval or question). */
	attentionSubagents: number
}

export interface ThreadStatusInfo extends LiveChildren {
	status: ThreadStatus
}

export type ThreadStatuses = Readonly<Record<string, ThreadStatusInfo>>

/**
 * Only an idle (done) thread changes: a subagent that needs the user makes it
 * "waiting for you"; otherwise live children make it "waiting on subagents".
 * Running, waiting and error threads keep their own status.
 */
export function deriveThreadStatus(status: SessionStatus, live: LiveChildren): ThreadStatus {
	if (status !== "done") return status
	if (live.attentionSubagents > 0) return "waiting"
	return live.liveSubagents > 0 || live.liveSubthreads > 0 ? "subagents" : "done"
}

/** Running, waiting for the user, or waiting on its subagents: the thread still has work in flight. */
export function isLiveThreadStatus(status: ThreadStatus): boolean {
	return status === "running" || status === "waiting" || status === "subagents"
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`

/** "Waiting on 2 subagents", "Waiting on 1 subthread", or both joined with "and". */
export function waitingOnLabel(liveSubagents: number, liveSubthreads: number): string {
	const parts = [
		liveSubagents > 0 ? plural(liveSubagents, "subagent") : "",
		liveSubthreads > 0 ? plural(liveSubthreads, "subthread") : "",
	].filter(Boolean)
	return parts.length ? `Waiting on ${parts.join(" and ")}` : "Waiting on subagents"
}

/** Derived status for every thread in history or in the status map. */
export function buildThreadStatuses(history: readonly HistoryItem[], statuses: SessionStatuses | undefined): ThreadStatuses {
	const raw = (id: string): SessionStatus => statuses?.[id] ?? "done"
	const childrenByParent = new Map<string, HistoryItem[]>()
	for (const item of history) {
		if (!item.parentTaskId) continue
		const siblings = childrenByParent.get(item.parentTaskId) ?? []
		siblings.push(item)
		childrenByParent.set(item.parentTaskId, siblings)
	}
	const result: Record<string, ThreadStatusInfo> = {}
	const ids = new Set([...history.map((item) => item.id), ...Object.keys(statuses ?? {})])
	for (const id of ids) {
		const children = childrenByParent.get(id) ?? []
		// Subagents nest: a subagent's own subagents also keep the top thread waiting.
		const agents: HistoryItem[] = []
		const seen = new Set([id])
		const pending = children.filter((child) => child.isSubagent)
		for (const agent of pending) {
			if (seen.has(agent.id)) continue
			seen.add(agent.id)
			agents.push(agent)
			pending.push(...(childrenByParent.get(agent.id) ?? []).filter((nested) => nested.isSubagent))
		}
		const live: LiveChildren = {
			liveSubagents: agents.filter((agent) => raw(agent.id) === "running" || raw(agent.id) === "waiting").length,
			liveSubthreads: children.filter((child) => !child.isSubagent && raw(child.id) === "running").length,
			attentionSubagents: agents.filter((agent) => raw(agent.id) === "waiting").length,
		}
		result[id] = { ...live, status: deriveThreadStatus(raw(id), live) }
	}
	return result
}

export function threadStatusFor(statuses: ThreadStatuses | undefined, id: string): ThreadStatus {
	return statuses?.[id]?.status ?? "done"
}

/** Plain id → status map (what the toast rules compare between snapshots). */
export function threadStatusMap(statuses: ThreadStatuses): Record<string, ThreadStatus> {
	return Object.fromEntries(Object.entries(statuses).map(([id, info]) => [id, info.status]))
}

/** Accessible label and tooltip for a thread's status. */
export function threadStatusLabel(info: ThreadStatusInfo | undefined): string | undefined {
	return info?.status === "subagents" ? waitingOnLabel(info.liveSubagents, info.liveSubthreads) : undefined
}
