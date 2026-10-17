import type { WorktreeActionResult, WorktreeState } from "@shared/thread-worktrees"
import { useCallback, useEffect, useState, useSyncExternalStore } from "react"
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
	return JSON.parse(response.json)
}

let enabled = false
let draftThreadId: string | undefined
const listeners = new Set<() => void>()
function setDraft(value: boolean) {
	enabled = value
	for (const listener of listeners) listener()
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
	const [state, setState] = useState<WorktreeState>()
	const [error, setError] = useState<string>()
	const refresh = useCallback(async () => {
		try {
			setState((await threadWorktreeAction("state", threadId)).state)
			setError(undefined)
		} catch (error) {
			setError(String(error))
		}
	}, [threadId])
	useEffect(() => {
		void refresh()
	}, [refresh])
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
