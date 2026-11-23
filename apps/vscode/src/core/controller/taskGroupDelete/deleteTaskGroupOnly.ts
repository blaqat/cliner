import { type TaskGroupDeleteRequest, TaskGroupDeleteResult } from "@shared/proto/cline/task_group_delete"
import { validateTaskGroupIdentifier } from "@/sdk/task-groups/task-group-store"
import type { Controller } from ".."
import { toProtoPreview } from "./previewTaskGroupDelete"

/** Deletes just the task (its threads stay, unfiled), removing its worktree first. */
export async function deleteTaskGroupOnly(
	controller: Controller,
	request: TaskGroupDeleteRequest,
): Promise<TaskGroupDeleteResult> {
	validateTaskGroupIdentifier(request.id, "id")
	if (!request.id) throw new Error("id is required")
	const result = await controller.deleteTaskGroupOnly(request.id, request.discardWorktreeWork, request.removalConfirmation)
	return TaskGroupDeleteResult.create({
		deleted: result.deleted,
		blocked: result.blocked ?? "",
		preview: result.preview ? toProtoPreview(result.preview) : undefined,
	})
}
