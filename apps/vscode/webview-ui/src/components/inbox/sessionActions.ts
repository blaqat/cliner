import { StringRequest } from "@shared/proto/cline/common"
import { RenameTaskRequest, StopSubagentRequest, TaskSettledRequest } from "@shared/proto/cline/task"
import { TaskServiceClient } from "@/services/grpc-client"
import { beginHistoryPatch } from "./optimisticHistory"

/** Focuses a task (history or live session) without stopping the one that was focused. */
export function openTask(taskId: string): Promise<void> {
	document.dispatchEvent(new CustomEvent("cline:open-thread", { detail: taskId }))
	return TaskServiceClient.showTaskWithId(StringRequest.create({ value: taskId })).then(
		() => undefined,
		(error) => console.error("Error showing task:", error),
	)
}

/** Sets a thread's user-facing title; an empty title restores the first-message default. Resolves false on failure. */
export function renameTask(taskId: string, title: string): Promise<boolean> {
	return TaskServiceClient.renameTask(RenameTaskRequest.create({ taskId, title })).then(
		() => true,
		(error) => {
			console.error("Failed to rename task:", error)
			return false
		},
	)
}

async function switchTasks(taskIds: string[], kind: "settled" | "stashed", value?: boolean): Promise<void> {
	if (!taskIds.length) return
	const finish = beginHistoryPatch(taskIds, (item) => {
		if (kind === "settled") {
			const isSettled = value ?? !item.isSettled
			return {
				isSettled,
				settledAt: isSettled ? Date.now() : undefined,
				...(isSettled ? { isStashed: false, stashedAt: undefined } : {}),
			}
		}
		const isStashed = value ?? !item.isStashed
		return {
			isStashed,
			stashedAt: isStashed ? Date.now() : undefined,
			...(isStashed ? { isSettled: false, settledAt: undefined } : {}),
		}
	})
	try {
		const request = TaskSettledRequest.create(value === undefined ? { taskId: taskIds[0] } : { taskIds, value })
		await (kind === "settled" ? TaskServiceClient.toggleTaskSettled(request) : TaskServiceClient.toggleTaskStashed(request))
	} finally {
		finish()
	}
}

export function setTasksSettled(taskIds: string[], value: boolean): Promise<void> {
	return switchTasks(taskIds, "settled", value)
}

export function setTasksStashed(taskIds: string[], value: boolean): Promise<void> {
	return switchTasks(taskIds, "stashed", value)
}

export function toggleTaskStashed(taskId: string): Promise<void> {
	return switchTasks([taskId], "stashed").catch((error) => console.error("Failed to stash task:", error))
}

/** Flips a task between the Active and Settled inbox groups. */
export function toggleTaskSettled(taskId: string): Promise<void> {
	return switchTasks([taskId], "settled").catch((error) => console.error("Failed to toggle settled:", error))
}

/**
 * Aborts one running subagent of a task. `subagentId` is the strip chip id (`<statusTs>:<index>`).
 * Resolves false when the stop failed (the child may still be running).
 */
export function stopSubagent(taskId: string, subagentId: string): Promise<boolean> {
	return TaskServiceClient.stopSubagent(StopSubagentRequest.create({ taskId, subagentId })).then(
		() => true,
		(error) => {
			console.error("Failed to stop subagent:", error)
			return false
		},
	)
}
