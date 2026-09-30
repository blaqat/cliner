import { String as StringResponse } from "@shared/proto/cline/common"
import type { ForkTaskAtRequest } from "@shared/proto/cline/task"
import type { Controller } from ".."

export async function forkTaskAt(controller: Controller, request: ForkTaskAtRequest): Promise<StringResponse> {
	if (!request.taskId) throw new Error("taskId is required")
	return StringResponse.create({ value: await controller.forkTaskAt(request.taskId, request.messageTs) })
}
