import type { ThreadWorkspaceChoice, WorktreeActionResult, WorktreeState } from "@shared/thread-worktrees"
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { WorktreeServiceClient } from "@/services/grpc-client"

export async function threadWorktreeAction(
	action: string,
	threadId = "",
	data?: unknown,
	confirmed = false,
	taskGroupId?: string,
): Promise<WorktreeActionResult> {
	const response = await WorktreeServiceClient.threadWorktreeAction({
		action,
		threadId,
		json: data === undefined ? "" : JSON.stringify(data),
		confirmed,
		...(taskGroupId ? { taskGroupId } : {}),
	})
	const result: WorktreeActionResult = JSON.parse(response.json)
	if (SETTINGS_ACTIONS.has(action)) settingsSaved()
	return result
}

/** Actions that change what every worktree menu offers; each mounted useWorktree re-reads after one. */
const SETTINGS_ACTIONS = new Set(["configure", "workspaceOff", "createTaskWorktree", "remove", "takeOver"])
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

let draft: { scope: ThreadWorkspaceChoice; taskGroupId?: string } | undefined
let draftThreadId: string | undefined
const listeners = new Set<() => void>()
function setDraft(scope?: ThreadWorkspaceChoice, taskGroupId?: string) {
	draft = scope ? { scope, taskGroupId } : undefined
	for (const listener of listeners) listener()
}

/** The where pill's "Run in worktree" pick for the next new thread; the send path reads it. */
export function getDraftRunInWorktree(): boolean {
	return draft?.scope === "thread" && !draft.taskGroupId
}

export function getDraftWorktreeScope(taskGroupId?: string): ThreadWorkspaceChoice | undefined {
	return draft?.taskGroupId === taskGroupId ? draft?.scope : undefined
}

/** Cleared once a thread starts with it, like the composer's pending task pick. */
export function clearDraftRunInWorktree(): void {
	if (draft) setDraft()
}

/** Mount in the composer's where pill. Pass `enabled` as NewTaskRequest.runInWorktree. */
export function useWorktree(threadId?: string, taskGroupId?: string) {
	const { currentTaskItem, sessionStatuses } = useExtensionState()
	const draftScope = useSyncExternalStore(
		(listener) => {
			listeners.add(listener)
			return () => {
				listeners.delete(listener)
			}
		},
		() => getDraftWorktreeScope(taskGroupId),
	)
	const savedSettings = useSyncExternalStore(subscribeSettings, () => settingsVersion)
	const group = threadId === currentTaskItem?.id ? currentTaskItem?.taskGroupId : undefined
	const status = threadId ? sessionStatuses?.[threadId] : undefined
	const key = JSON.stringify([threadId, taskGroupId, group])
	const [snapshot, setSnapshot] = useState<{ key: string; state?: WorktreeState }>()
	const state = snapshot?.key === key ? snapshot.state : undefined
	const [error, setError] = useState<string>()
	const refreshId = useRef(0)
	const refresh = useCallback(
		async (refreshMm = false) => {
			const id = ++refreshId.current
			try {
				const result = await threadWorktreeAction(
					"state",
					threadId,
					refreshMm ? { refreshMm } : undefined,
					false,
					taskGroupId,
				)
				if (id !== refreshId.current) return
				setSnapshot({ key, state: result.state })
				setError(undefined)
			} catch (error) {
				if (id === refreshId.current) setError(`Couldn't check worktrees: ${worktreeErrorText(error)}`)
			}
		},
		[threadId, taskGroupId, key],
	)
	// Saved settings change availability for menus that stayed mounted (the composer's), not just Settings.
	// biome-ignore lint/correctness/useExhaustiveDependencies: Refresh after a save or when a new thread is persisted.
	useEffect(() => {
		void refresh()
	}, [refresh, savedSettings, status])
	useEffect(() => {
		if (draftThreadId !== currentTaskItem?.id) {
			draftThreadId = currentTaskItem?.id
			setDraft()
		}
	}, [currentTaskItem?.id])
	const setScope = useCallback((scope?: ThreadWorkspaceChoice) => setDraft(scope, taskGroupId), [taskGroupId])
	const setEnabled = useCallback(
		async (value: boolean) => setScope(value ? "thread" : taskGroupId ? "workspace" : undefined),
		[setScope, taskGroupId],
	)
	return {
		state,
		enabled: threadId ? !!state?.mapping : draftScope === "thread" || draftScope === "task",
		scope: draftScope,
		setScope,
		availability: state?.availability,
		setEnabled,
		refresh,
		error,
		busy: false,
	}
}
