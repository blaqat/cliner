import { Empty } from "@shared/proto/cline/common"
import { DiscardNotebookChangesRequest } from "@shared/proto/cline/task_group"
import { validateTaskGroupIdentifier } from "@/sdk/task-groups/task-group-store"
import { Controller } from ".."

/**
 * Discards a thread's staged notebook changes.
 * @param controller The controller instance
 * @param request The request containing the thread id
 * @returns Empty response
 */
export async function discardNotebookChanges(controller: Controller, request: DiscardNotebookChangesRequest): Promise<Empty> {
	validateTaskGroupIdentifier(request.threadId, "threadId")
	validateTaskGroupIdentifier(request.taskGroupId, "taskGroupId")
	if (!request.threadId) {
		throw new Error("threadId is required")
	}
	for (const slug of request.slugs) validateTaskGroupIdentifier(slug, "slug")
	await controller.discardNotebookChanges(request.threadId, request.taskGroupId, request.revision, request.slugs)
	return Empty.create({})
}
