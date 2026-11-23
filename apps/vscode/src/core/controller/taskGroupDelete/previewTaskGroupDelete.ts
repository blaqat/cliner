import {
	TaskGroupDeletePreview,
	type TaskGroupDeleteRequest,
	TaskGroupDeleteTaskWorktree,
	TaskGroupDeleteThread,
} from "@shared/proto/cline/task_group_delete"
import type { TaskGroupDeletePreview as Preview } from "@/sdk/task-groups/task-group-delete"
import { validateTaskGroupIdentifier } from "@/sdk/task-groups/task-group-store"
import type { Controller } from ".."

export const toProtoPreview = ({ threads, taskWorktree }: Preview) =>
	TaskGroupDeletePreview.create({
		threads: threads.map((thread) => TaskGroupDeleteThread.create(thread)),
		taskWorktree: taskWorktree ? TaskGroupDeleteTaskWorktree.create(taskWorktree) : undefined,
	})

/** What deleting a task together with its threads would stop, remove and lose. Read-only. */
export async function previewTaskGroupDelete(
	controller: Controller,
	request: TaskGroupDeleteRequest,
): Promise<TaskGroupDeletePreview> {
	validateTaskGroupIdentifier(request.id, "id")
	if (!request.id) throw new Error("id is required")
	return toProtoPreview(await controller.previewTaskGroupDelete(request.id))
}
