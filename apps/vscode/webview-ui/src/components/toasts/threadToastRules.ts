import type { HistoryItem } from "@shared/HistoryItem"
import type { ThreadStatusMap } from "@/components/inbox/threadStatus"

/** `done`: a background thread finished its turn. `input`: it waits on an approval or a question. */
export type ThreadToastKind = "done" | "input"

export interface ThreadToast {
	id: number
	/** The thread the action opens (a subagent's parent, since its decisions show there). */
	threadId: string
	/** The thread whose status changed. */
	sourceId: string
	kind: ThreadToastKind
}

export interface ThreadToastEvent {
	threadId: string
	sourceId: string
	kind: ThreadToastKind
}

export const MAX_THREAD_TOASTS = 3
export const DEFAULT_TOAST_SECONDS = 5

export interface ToastEventContext {
	/** The thread on screen; it never toasts. */
	viewingThreadId?: string
	history: readonly HistoryItem[]
	/** Threads the user just stopped; their running → done is not a completion. */
	stoppedIds?: ReadonlySet<string>
}

/**
 * Which status changes toast. `previous` undefined is the first snapshot after
 * load: it only sets the baseline, so reopening the sidebar doesn't replay
 * everything that is already done or waiting.
 * Statuses are the derived thread statuses, so a thread whose own turn ended
 * while its subagents still run is "subagents", not done.
 * - running → done toasts "finished". A stop also lands on done; those ids
 *   come in `stoppedIds`. Failures land on error and never toast.
 * - running → subagents is not a finish; subagents → done (the subagents
 *   finished and the thread is idle) toasts "finished".
 * - anything → waiting toasts "needs input".
 * - Subagents never toast on finishing (their parent reports back). Their
 *   decisions surface in the parent thread, so an input toast opens the parent.
 */
export function threadToastEvents(
	previous: ThreadStatusMap | undefined,
	next: ThreadStatusMap,
	{ viewingThreadId, history, stoppedIds }: ToastEventContext,
): ThreadToastEvent[] {
	if (!previous) return []
	const byId = new Map(history.map((item) => [item.id, item]))
	const events: ThreadToastEvent[] = []
	for (const [id, status] of Object.entries(next)) {
		const before = previous[id]
		if (status === before) continue
		const item = byId.get(id)
		const target = item?.isSubagent && item.parentTaskId ? item.parentTaskId : id
		if (id === viewingThreadId || target === viewingThreadId) continue
		if (status === "waiting") {
			events.push({ threadId: target, sourceId: id, kind: "input" })
		} else if (
			status === "done" &&
			(before === "running" || before === "subagents") &&
			!item?.isSubagent &&
			!stoppedIds?.has(id)
		) {
			events.push({ threadId: target, sourceId: id, kind: "done" })
		}
	}
	return events
}

/** Adds new toasts newest first, one per thread, at most MAX_THREAD_TOASTS. */
export function addThreadToasts(
	toasts: readonly ThreadToast[],
	events: readonly ThreadToastEvent[],
	nextId: () => number,
): ThreadToast[] {
	let result = [...toasts]
	for (const event of events) {
		result = [{ id: nextId(), ...event }, ...result.filter((toast) => toast.threadId !== event.threadId)]
	}
	return result.slice(0, MAX_THREAD_TOASTS)
}

/**
 * Drops toasts that no longer apply: any for the thread now on screen, and
 * input toasts whose thread stopped waiting (handled elsewhere).
 */
export function pruneThreadToasts(
	toasts: readonly ThreadToast[],
	statuses: ThreadStatusMap,
	viewingThreadId: string | undefined,
): ThreadToast[] {
	const kept = toasts.filter(
		(toast) =>
			toast.threadId !== viewingThreadId &&
			toast.sourceId !== viewingThreadId &&
			(toast.kind !== "input" || statuses[toast.sourceId] === "waiting"),
	)
	return kept.length === toasts.length ? (toasts as ThreadToast[]) : kept
}

/** Milliseconds a toast stays; null means it has no timer (needs-input toasts wait to be handled). */
export function threadToastDurationMs(kind: ThreadToastKind, seconds: number | undefined): number | null {
	if (kind === "input") return null
	const value = seconds && Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_TOAST_SECONDS
	return value * 1000
}

// The stop button only reaches the focused thread, which never toasts; this
// covers stopping it and switching away before the status push lands.
const recentlyStopped = new Map<string, number>()
const STOP_MEMORY_MS = 10_000

export function noteThreadStopped(threadId: string | undefined, now = Date.now()): void {
	if (threadId) recentlyStopped.set(threadId, now)
}

export function recentlyStoppedIds(now = Date.now()): Set<string> {
	for (const [id, at] of recentlyStopped) {
		if (now - at > STOP_MEMORY_MS) recentlyStopped.delete(id)
	}
	return new Set(recentlyStopped.keys())
}
