import { useMemo } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { buildThreadStatuses, type ThreadStatuses } from "./threadStatus"

/** Derived thread statuses (with "waiting on subagents") from the current extension state. */
export function useThreadStatuses(): ThreadStatuses {
	const { taskHistory, sessionStatuses } = useExtensionState()
	return useMemo(() => buildThreadStatuses(taskHistory ?? [], sessionStatuses), [taskHistory, sessionStatuses])
}
