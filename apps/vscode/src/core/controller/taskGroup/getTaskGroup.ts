import { GetTaskGroupRequest, GetTaskGroupResponse } from "@shared/proto/cline/task_group"
import { Controller } from ".."
import { notebookNoteMetaToProto, taskGroupSummaryToProto, taskGroupThreadToProto } from "./conversions"

/**
 * Gets a task group with its notes and thread timeline.
 * @param controller The controller instance
 * @param request The request containing the task group id
 * @returns GetTaskGroupResponse with the group, its notes, and member threads
 */
export async function getTaskGroup(controller: Controller, request: GetTaskGroupRequest): Promise<GetTaskGroupResponse> {
	if (!request.id) {
		throw new Error("id is required")
	}
	const result = await controller.getTaskGroup(request.id)
	if (!result) {
		throw new Error(`Task group not found: ${request.id}`)
	}
	return GetTaskGroupResponse.create({
		group: taskGroupSummaryToProto(result.group),
		notes: result.notes.map(notebookNoteMetaToProto),
		threads: result.threads.map(taskGroupThreadToProto),
	})
}
