import { useEffect, useRef } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"

/**
 * Deleting the thread you are inside must not strand you on a dead view. The host closes the
 * thread and posts `deletedOpenThread` with a new `seq`; this leaves for the thread's task page
 * (when that task still exists) or else home, so a new thread is one keystroke away.
 *
 * Reacts once per new `seq`. The `seq` already in the first hydrated state is history, not an event
 * (a reloaded webview must not navigate for a delete that happened before it). This also handles
 * deletes from History while the chat is hidden behind that page.
 */
export function useLeaveDeletedThread({
	openTaskGroup,
	goHome,
}: {
	openTaskGroup: (taskGroupId: string) => void
	goHome: () => void
}): void {
	const { deletedOpenThread, taskGroups, didHydrateState } = useExtensionState()
	const seq = deletedOpenThread?.seq
	const handledSeqRef = useRef<number | null | undefined>(undefined)
	const latestRef = useRef({ openTaskGroup, goHome })
	latestRef.current = { openTaskGroup, goHome }
	const taskGroupsRef = useRef(taskGroups)
	taskGroupsRef.current = taskGroups

	useEffect(() => {
		if (!didHydrateState) return
		if (handledSeqRef.current === undefined) {
			handledSeqRef.current = seq ?? null
			return
		}
		if (seq === undefined || (handledSeqRef.current !== null && seq <= handledSeqRef.current)) return
		handledSeqRef.current = seq
		const taskGroupId = deletedOpenThread?.taskGroupId
		const { openTaskGroup: open, goHome: home } = latestRef.current
		if (taskGroupId && taskGroupsRef.current?.some((group) => group.id === taskGroupId)) open(taskGroupId)
		else home()
	}, [didHydrateState, seq, deletedOpenThread?.taskGroupId])
}
