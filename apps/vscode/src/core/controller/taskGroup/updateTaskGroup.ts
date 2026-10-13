import { TaskGroupSummary, UpdateTaskGroupRequest } from "@shared/proto/cline/task_group"
import { Controller } from ".."
import { protoToTaskTag, taskGroupSummaryToProto } from "./conversions"

/**
 * Renames a task group and/or replaces its tags.
 * @param controller The controller instance
 * @param request The request with the group id and fields to update
 * @returns TaskGroupSummary of the updated group
 */
export async function updateTaskGroup(controller: Controller, request: UpdateTaskGroupRequest): Promise<TaskGroupSummary> {
	if (!request.id) {
		throw new Error("id is required")
	}
	const group = await controller.updateTaskGroup(request.id, {
		title: request.title,
		tags: request.tags ? request.tags.tags.map(protoToTaskTag) : undefined,
	})
	return taskGroupSummaryToProto(group)
}
