import { protoToTaskTag } from "@core/controller/taskGroup/conversions"
import { Empty } from "@shared/proto/cline/common"
import type { SetThreadTagsRequest } from "@shared/proto/cline/task"
import type { Controller } from ".."

/**
 * Replaces a thread's tags and records auto tags the user dismissed.
 * @param controller The controller instance
 * @param request The request containing the task id, tags and dismissed auto tags
 * @returns Empty response
 */
export async function setThreadTags(controller: Controller, request: SetThreadTagsRequest): Promise<Empty> {
	if (!request.taskId) throw new Error("taskId is required")
	await controller.setThreadTags(request.taskId, request.tags.map(protoToTaskTag), request.dismissedAutoTags)
	return Empty.create({})
}
