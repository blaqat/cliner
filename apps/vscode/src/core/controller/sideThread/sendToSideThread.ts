import { normalizeProvenance } from "@shared/composer-provenance"
import { Empty } from "@shared/proto/cline/common"
import type { SendToSideThreadRequest } from "@shared/proto/cline/side_thread"
import type { Controller } from ".."

/** Rejects when the side thread can't take a message here, so the webview keeps the draft. */
export async function sendToSideThread(controller: Controller, request: SendToSideThreadRequest): Promise<Empty> {
	if (!request.threadId) throw new Error("threadId is required")
	await controller.sendToSideThread(
		request.threadId,
		request.text,
		request.images,
		request.files,
		normalizeProvenance(request.provenance),
	)
	return Empty.create({})
}
