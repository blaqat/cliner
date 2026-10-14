import { Empty } from "@shared/proto/cline/common"
import { OpenNoteRequest } from "@shared/proto/cline/task_group"
import { validateTaskGroupIdentifier } from "@/sdk/task-groups/task-group-store"
import { Controller } from ".."

/**
 * Opens a notebook note file in the editor.
 * @param controller The controller instance
 * @param request The request with the group id and note slug
 * @returns Empty response
 */
export async function openNote(controller: Controller, request: OpenNoteRequest): Promise<Empty> {
	validateTaskGroupIdentifier(request.taskGroupId, "taskGroupId")
	validateTaskGroupIdentifier(request.slug, "slug")
	if (!request.taskGroupId) {
		throw new Error("taskGroupId is required")
	}
	if (!request.slug) {
		throw new Error("slug is required")
	}
	await controller.openNote(request.taskGroupId, request.slug)
	return Empty.create({})
}
