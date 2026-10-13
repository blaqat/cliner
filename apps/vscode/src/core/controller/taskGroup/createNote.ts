import { CreateNoteRequest, CreateNoteResponse } from "@shared/proto/cline/task_group"
import { Controller } from ".."

/**
 * Creates a notebook note and returns its absolute file path.
 * @param controller The controller instance
 * @param request The request with the group id, note name and description
 * @returns CreateNoteResponse with the absolute path of the created note file
 */
export async function createNote(controller: Controller, request: CreateNoteRequest): Promise<CreateNoteResponse> {
	if (!request.taskGroupId) {
		throw new Error("taskGroupId is required")
	}
	if (!request.name.trim()) {
		throw new Error("name is required")
	}
	const filePath = await controller.createNote(request.taskGroupId, request.name, request.description)
	return CreateNoteResponse.create({ path: filePath })
}
