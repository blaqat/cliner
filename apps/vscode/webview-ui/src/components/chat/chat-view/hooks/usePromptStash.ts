import { PromptStash, UpdateSettingsRequest } from "@shared/proto/cline/state"
import { useCallback, useEffect, useSyncExternalStore } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { StateServiceClient } from "@/services/grpc-client"
import {
	createStashId,
	isDraftEmpty,
	type PromptStashEntry,
	pushStashEntry,
	removeStashEntry,
	type StashableDraft,
	takeStashEntry,
} from "../utils/promptStash"

type Listener = () => void

/**
 * Webview-wide mirror of the global `promptStash` state. The stash is global
 * (not per chat), so it lives outside React state and survives the composer
 * remounting between chats. Local edits apply immediately and are persisted
 * through updateSettings; state posted by the host replaces the mirror.
 */
let entries: PromptStashEntry[] = []
const listeners = new Set<Listener>()

function setEntries(next: PromptStashEntry[]) {
	if (next === entries) {
		return false
	}
	entries = next
	for (const listener of listeners) {
		listener()
	}
	return true
}

function commit(next: PromptStashEntry[]) {
	if (!setEntries(next)) {
		return
	}
	StateServiceClient.updateSettings(UpdateSettingsRequest.create({ promptStash: PromptStash.create({ entries: next }) })).catch(
		(error) => console.error("Failed to persist prompt stash:", error),
	)
}

function subscribe(listener: Listener) {
	listeners.add(listener)
	return () => listeners.delete(listener)
}

function getSnapshot() {
	return entries
}

/** Test helper: resets the in-memory stash without persisting. */
export function resetPromptStashForTests(initial: PromptStashEntry[] = []) {
	setEntries(initial)
}

export interface PromptStashControls {
	entries: PromptStashEntry[]
	/** Stashes the draft. Returns false (and does nothing) when the draft is empty. */
	stash: (draft: StashableDraft) => boolean
	/** Removes entry `id` and returns it; a non-empty `currentDraft` is swapped into the stash. */
	restore: (id: string, currentDraft: StashableDraft) => PromptStashEntry | undefined
	remove: (id: string) => void
}

export function usePromptStash(taskId?: string): PromptStashControls {
	const { promptStash } = useExtensionState()
	const current = useSyncExternalStore(subscribe, getSnapshot)

	useEffect(() => {
		if (promptStash) {
			setEntries(promptStash)
		}
	}, [promptStash])

	const stash = useCallback(
		(draft: StashableDraft) => {
			if (isDraftEmpty(draft)) {
				return false
			}
			commit(pushStashEntry(entries, draft, { id: createStashId(), ts: Date.now(), taskId }))
			return true
		},
		[taskId],
	)

	const restore = useCallback(
		(id: string, currentDraft: StashableDraft) => {
			const result = takeStashEntry(entries, id, currentDraft, { id: createStashId(), ts: Date.now(), taskId })
			commit(result.entries)
			return result.restored
		},
		[taskId],
	)

	const remove = useCallback((id: string) => commit(removeStashEntry(entries, id)), [])

	return { entries: current, stash, restore, remove }
}
