import { Empty } from "@shared/proto/cline/common"
import type { StopSubagentRequest } from "@shared/proto/cline/task"
import type { Controller } from ".."

export async function stopSubagent(controller: Controller, request: StopSubagentRequest): Promise<Empty> {
	if (!request.taskId || !request.subagentId) throw new Error("taskId and subagentId are required")
	await controller.stopSubagent(request.taskId, request.subagentId)
	return Empty.create({})
}
