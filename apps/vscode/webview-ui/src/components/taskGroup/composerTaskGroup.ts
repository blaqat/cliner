import { useEffect, useRef, useSyncExternalStore } from "react"

// The task group picked with the composer's task pill before the first message
// of a new thread. The send path reads it into NewTaskRequest.task_group_id and
// clears it once the thread starts. Existing threads don't use this: picking
// there files the thread right away (setThreadTaskGroup).

let pendingTaskGroupId: string | undefined
const listeners = new Set<() => void>()

export function getComposerTaskGroup(): string | undefined {
	return pendingTaskGroupId
}

export function setComposerTaskGroup(id: string | undefined): void {
	if (pendingTaskGroupId === id) return
	pendingTaskGroupId = id
	for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener)
	return () => listeners.delete(listener)
}

export function useComposerTaskGroup(): string | undefined {
	return useSyncExternalStore(subscribe, getComposerTaskGroup)
}

/**
 * Leaving a task (its page, or one of its threads) for home drops the composer's task pick, so
 * home starts without a task. `inTask` is the task on screen, if any.
 */
export function useClearComposerTaskOnLeavingTask(inTask: string | undefined): void {
	const previous = useRef(inTask)
	useEffect(() => {
		if (previous.current && !inTask) setComposerTaskGroup(undefined)
		previous.current = inTask
	}, [inTask])
}

// The task page whose composer is showing. While set, every new thread from the
// composer (foreground or background) is filed into it and the pill is fixed to
// it. Unlike the pending pick it isn't cleared by sends, only when the page closes.
let pageTaskGroupId: string | undefined

export function getComposerPageTaskGroup(): string | undefined {
	return pageTaskGroupId
}

export function setComposerPageTaskGroup(id: string | undefined): void {
	if (pageTaskGroupId === id) return
	pageTaskGroupId = id
	for (const listener of listeners) listener()
}

export function useComposerPageTaskGroup(): string | undefined {
	return useSyncExternalStore(subscribe, getComposerPageTaskGroup)
}

/**
 * One precedence for "which task does this composer belong to": the task page,
 * then the pill's pending pick, then the open thread's own task (if any).
 */
export function resolveComposerTaskGroup(threadTaskGroupId?: string): string | undefined {
	return pageTaskGroupId ?? pendingTaskGroupId ?? threadTaskGroupId
}

/** The task a new thread sent from the composer is filed into. */
export function getComposerSendTaskGroup(): string | undefined {
	return resolveComposerTaskGroup()
}

/** Reactive {@link resolveComposerTaskGroup}. */
export function useResolvedComposerTaskGroup(threadTaskGroupId?: string): string | undefined {
	const page = useComposerPageTaskGroup()
	const pending = useComposerTaskGroup()
	return page ?? pending ?? threadTaskGroupId
}

// The task pill's new-task sheet. Kept outside the pill so the sheet survives
// the pill unmounting (it moves into the composer's "…" menu when narrow).
let sheetOpen = false
const sheetListeners = new Set<() => void>()

export function setComposerTaskSheetOpen(open: boolean): void {
	if (sheetOpen === open) return
	sheetOpen = open
	for (const listener of sheetListeners) listener()
}

function subscribeSheet(listener: () => void): () => void {
	sheetListeners.add(listener)
	return () => sheetListeners.delete(listener)
}

export function useComposerTaskSheetOpen(): boolean {
	return useSyncExternalStore(subscribeSheet, () => sheetOpen)
}
