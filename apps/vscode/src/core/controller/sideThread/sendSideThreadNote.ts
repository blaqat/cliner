import { Empty } from "@shared/proto/cline/common"
import type { SendSideThreadNoteRequest } from "@shared/proto/cline/side_thread"
import type { Controller } from ".."

/** Sends a note the user approved to the side thread's main thread. */
export async function sendSideThreadNote(controller: Controller, request: SendSideThreadNoteRequest): Promise<Empty> {
	if (!request.threadId) throw new Error("threadId is required")
	await controller.sendSideThreadNote(request.threadId, request.text)
	return Empty.create({})
}
