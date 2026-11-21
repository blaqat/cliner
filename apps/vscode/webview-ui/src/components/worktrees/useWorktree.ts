import type { WorktreeActionResult, WorktreeState } from "@shared/thread-worktrees"
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { WorktreeServiceClient } from "@/services/grpc-client"

export async function threadWorktreeAction(
	action: string,
	threadId = "",
	data?: unknown,
	confirmed = false,
): Promise<WorktreeActionResult> {
	const response = await WorktreeServiceClient.threadWorktreeAction({
		action,
		threadId,
		json: data === undefined ? "" : JSON.stringify(data),
		confirmed,
	})
	const result: WorktreeActionResult = JSON.parse(response.json)
	if (SETTINGS_ACTIONS.has(action)) settingsSaved()
	return result
}

/** Actions that change what every worktree menu offers; each mounted useWorktree re-reads after one. */
const SETTINGS_ACTIONS = new Set(["configure", "workspaceOff"])
let settingsVersion = 0
const settingsListeners = new Set<() => void>()
function settingsSaved() {
	settingsVersion++
	for (const listener of settingsListeners) listener()
}
function subscribeSettings(listener: () => void) {
	settingsListeners.add(listener)
	return () => {
		settingsListeners.delete(listener)
	}
}

/** gRPC errors arrive as "Error: git worktree add: …"; people want the sentence. */
export function worktreeErrorText(error: unknown): string {
	return String(error instanceof Error ? error.message : error)
		.replace(/^(Error:\s*)+/, "")
		.replace(/^Failed to start task:\s*/, "")
		.trim()
}

let startFailure: string | undefined
const startFailureListeners = new Set<() => void>()
function setStartFailure(value: string | undefined) {
	if (startFailure === value) return
	startFailure = value
	for (const listener of startFailureListeners) listener()
}

/** A new thread couldn't start because its worktree couldn't be made; the composer says so until handled. */
export function reportWorktreeStartFailure(error: unknown): void {
	setStartFailure(worktreeErrorText(error) || "The worktree couldn't be made.")
}

export function clearWorktreeStartFailure(): void {
	setStartFailure(undefined)
}

export function useWorktreeStartFailure(): string | undefined {
	return useSyncExternalStore(
		(listener) => {
			startFailureListeners.add(listener)
			return () => {
				startFailureListeners.delete(listener)
			}
		},
		() => startFailure,
	)
}

let enabled = false
let draftThreadId: string | undefined
const listeners = new Set<() => void>()
function setDraft(value: boolean) {
	enabled = value
	for (const listener of listeners) listener()
}

/** The where pill's "Run in worktree" pick for the next new thread; the send path reads it. */
export function getDraftRunInWorktree(): boolean {
	return enabled
}

/** Cleared once a thread starts with it, like the composer's pending task pick. */
export function clearDraftRunInWorktree(): void {
	if (enabled) setDraft(false)
}

/** Mount in the composer's where pill. Pass `enabled` as NewTaskRequest.runInWorktree. */
export function useWorktree(threadId?: string) {
	const { currentTaskItem } = useExtensionState()
	const draftEnabled = useSyncExternalStore(
		(listener) => {
			listeners.add(listener)
			return () => {
				listeners.delete(listener)
			}
		},
		() => enabled,
	)
	const savedSettings = useSyncExternalStore(subscribeSettings, () => settingsVersion)
	const [state, setState] = useState<WorktreeState>()
	const [error, setError] = useState<string>()
	const refreshId = useRef(0)
	const refresh = useCallback(
		async (refreshMm = false) => {
			const id = ++refreshId.current
			try {
				const result = await threadWorktreeAction("state", threadId, refreshMm ? { refreshMm } : undefined)
				if (id !== refreshId.current) return
				setState(result.state)
				setError(undefined)
			} catch (error) {
				if (id === refreshId.current) setError(`Couldn't check worktrees: ${worktreeErrorText(error)}`)
			}
		},
		[threadId],
	)
	// Saved settings change availability for menus that stayed mounted (the composer's), not just Settings.
	// biome-ignore lint/correctness/useExhaustiveDependencies: savedSettings is the re-read trigger.
	useEffect(() => {
		void refresh()
	}, [refresh, savedSettings])
	useEffect(() => {
		if (draftThreadId !== currentTaskItem?.id) {
			draftThreadId = currentTaskItem?.id
			setDraft(false)
		}
	}, [currentTaskItem?.id])
	const setEnabled = useCallback(async (value: boolean) => setDraft(value), [])
	return {
		state,
		enabled: threadId ? !!state?.mapping : draftEnabled,
		availability: state?.availability,
		setEnabled,
		refresh,
		error,
		busy: false,
	}
}
