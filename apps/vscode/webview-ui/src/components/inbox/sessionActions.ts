import { StringRequest } from "@shared/proto/cline/common"
import { RenameTaskRequest, StopSubagentRequest, TaskSettledRequest } from "@shared/proto/cline/task"
import { TaskServiceClient } from "@/services/grpc-client"

/** Focuses a task (history or live session) without stopping the one that was focused. */
export function openTask(taskId: string): Promise<void> {
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

export function toggleTaskStashed(taskId: string): Promise<void> {
	return TaskServiceClient.toggleTaskStashed(TaskSettledRequest.create({ taskId })).then(
		() => undefined,
		(error) => console.error("Failed to stash task:", error),
	)
}

/** Flips a task between the Active and Settled inbox groups. */
export function toggleTaskSettled(taskId: string): Promise<void> {
	return TaskServiceClient.toggleTaskSettled(TaskSettledRequest.create({ taskId })).then(
		() => undefined,
		(error) => console.error("Failed to toggle settled:", error),
	)
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
