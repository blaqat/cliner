import { Empty } from "@shared/proto/cline/common"
import { DeleteTaskGroupRequest } from "@shared/proto/cline/task_group"
import { Controller } from ".."

/**
 * Deletes a task group; member threads are unfiled, never deleted.
 * @param controller The controller instance
 * @param request The request containing the task group id
 * @returns Empty response
 */
export async function deleteTaskGroup(controller: Controller, request: DeleteTaskGroupRequest): Promise<Empty> {
	if (!request.id) {
		throw new Error("id is required")
	}
	await controller.deleteTaskGroup(request.id)
	return Empty.create({})
}
