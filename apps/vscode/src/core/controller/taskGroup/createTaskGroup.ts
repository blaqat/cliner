import { CreateTaskGroupRequest, CreateTaskGroupResponse } from "@shared/proto/cline/task_group"
import { Controller } from ".."
import { protoToTaskTag } from "./conversions"

/**
 * Creates a task group; when thread_id is set the thread is filed into it.
 * @param controller The controller instance
 * @param request The request with the group title, tags and optional thread id
 * @returns CreateTaskGroupResponse with the new group id
 */
export async function createTaskGroup(controller: Controller, request: CreateTaskGroupRequest): Promise<CreateTaskGroupResponse> {
	if (!request.title.trim()) {
		throw new Error("title is required")
	}
	const id = await controller.createTaskGroup({
		title: request.title,
		tags: request.tags.map(protoToTaskTag),
		threadId: request.threadId || undefined,
	})
	return CreateTaskGroupResponse.create({ id })
}
