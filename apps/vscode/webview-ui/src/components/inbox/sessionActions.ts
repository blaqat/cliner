import { StringRequest } from "@shared/proto/cline/common"
import { StopSubagentRequest, TaskSettledRequest } from "@shared/proto/cline/task"
import { TaskServiceClient } from "@/services/grpc-client"

/** Focuses a task (history or live session) without stopping the one that was focused. */
export function openTask(taskId: string): Promise<void> {
	return TaskServiceClient.showTaskWithId(StringRequest.create({ value: taskId })).then(
		() => undefined,
		(error) => console.error("Error showing task:", error),
	)
}

/** Flips a task between the Active and Settled inbox groups. */
export function toggleTaskSettled(taskId: string): Promise<void> {
	return TaskServiceClient.toggleTaskSettled(TaskSettledRequest.create({ taskId })).then(
		() => undefined,
		(error) => console.error("Failed to toggle settled:", error),
	)
}

/** Aborts one running subagent of a task. `subagentId` is the strip chip id (`<statusTs>:<index>`). */
export function stopSubagent(taskId: string, subagentId: string): Promise<void> {
	return TaskServiceClient.stopSubagent(StopSubagentRequest.create({ taskId, subagentId })).then(
		() => undefined,
		(error) => console.error("Failed to stop subagent:", error),
	)
}
