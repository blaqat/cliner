import { useSyncExternalStore } from "react"

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
