import { normalizeProvenance } from "@shared/composer-provenance"
import { String as StringResponse } from "@shared/proto/cline/common"
import type { StartSideThreadRequest } from "@shared/proto/cline/side_thread"
import type { Controller } from ".."

/** Forks a thread into a side thread or side question; resolves with its id. */
export async function startSideThread(controller: Controller, request: StartSideThreadRequest): Promise<StringResponse> {
	if (!request.taskId) throw new Error("taskId is required")
	const id = await controller.startSideThread({
		taskId: request.taskId,
		messageTs: request.messageTs,
		kind: request.kind === "btw" ? "btw" : "side",
		text: request.text,
		images: request.images,
		files: request.files,
		provenance: normalizeProvenance(request.provenance),
		background: request.background,
	})
	return StringResponse.create({ value: id })
}
