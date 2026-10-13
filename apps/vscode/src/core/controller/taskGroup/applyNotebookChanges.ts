import { Empty } from "@shared/proto/cline/common"
import { ApplyNotebookChangesRequest } from "@shared/proto/cline/task_group"
import { Controller } from ".."

/**
 * Applies a thread's staged notebook changes.
 * @param controller The controller instance
 * @param request The request with the thread id and per-change include/edits
 * @returns Empty response
 */
export async function applyNotebookChanges(controller: Controller, request: ApplyNotebookChangesRequest): Promise<Empty> {
	if (!request.threadId) {
		throw new Error("threadId is required")
	}
	await controller.applyNotebookChanges(
		request.threadId,
		request.items.map((item) => ({ slug: item.slug, include: item.include, editedContent: item.editedContent })),
	)
	return Empty.create({})
}
