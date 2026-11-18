import { Empty } from "@shared/proto/cline/common"
import type { UpdateSideThreadRequest } from "@shared/proto/cline/side_thread"
import type { Controller } from ".."

/** Keeps a side question as a side thread, or closes a side thread. */
export async function updateSideThread(controller: Controller, request: UpdateSideThreadRequest): Promise<Empty> {
	if (!request.threadId) throw new Error("threadId is required")
	await controller.updateSideThread(request.threadId, {
		kind: request.kind === "side" ? "side" : undefined,
		closed: request.closed,
	})
	return Empty.create({})
}
