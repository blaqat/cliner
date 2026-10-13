import { Empty } from "@shared/proto/cline/common"
import { SetThreadTaskGroupRequest } from "@shared/proto/cline/task_group"
import { Controller } from ".."

/**
 * Moves a thread into a task group; empty task_group_id unfiles it.
 * @param controller The controller instance
 * @param request The request with the thread id and target group id
 * @returns Empty response
 */
export async function setThreadTaskGroup(controller: Controller, request: SetThreadTaskGroupRequest): Promise<Empty> {
	if (!request.threadId) {
		throw new Error("threadId is required")
	}
	await controller.setThreadTaskGroup(request.threadId, request.taskGroupId)
	return Empty.create({})
}
