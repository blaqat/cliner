import { Empty } from "@shared/proto/cline/common"
import type { RenameTaskRequest } from "@shared/proto/cline/task"
import type { Controller } from ".."

/**
 * Renames a thread (user-set title; empty clears it back to the first-message
 * default).
 * @param controller The controller instance
 * @param request The request containing the task id and new title
 * @returns Empty response
 */
export async function renameTask(controller: Controller, request: RenameTaskRequest): Promise<Empty> {
	if (!request.taskId) throw new Error("taskId is required")
	await controller.renameTask(request.taskId, request.title)
	return Empty.create({})
}
