import { type TaskGroupDeleteRequest, TaskGroupDeleteResult } from "@shared/proto/cline/task_group_delete"
import { validateTaskGroupIdentifier } from "@/sdk/task-groups/task-group-store"
import type { Controller } from ".."
import { toProtoPreview } from "./previewTaskGroupDelete"

/** Deletes a task and every thread in it, or nothing when a check fails (the result says why). */
export async function deleteTaskGroupWithThreads(
	controller: Controller,
	request: TaskGroupDeleteRequest,
): Promise<TaskGroupDeleteResult> {
	validateTaskGroupIdentifier(request.id, "id")
	if (!request.id) throw new Error("id is required")
	const result = await controller.deleteTaskGroupWithThreads(request.id, request.discardWorktreeWork)
	return TaskGroupDeleteResult.create({
		deleted: result.deleted,
		blocked: result.blocked ?? "",
		preview: result.preview ? toProtoPreview(result.preview) : undefined,
	})
}
