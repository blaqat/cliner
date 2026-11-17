import { Empty } from "@shared/proto/cline/common"
import type { StopSubagentRequest } from "@shared/proto/cline/task"
import type { Controller } from ".."

/** Rejects when the subagent could not be stopped so the webview can offer a retry. */
export async function stopSubagent(controller: Controller, request: StopSubagentRequest): Promise<Empty> {
	if (!request.taskId || !request.subagentId) throw new Error("taskId and subagentId are required")
	if (!(await controller.stopSubagent(request.taskId, request.subagentId))) {
		throw new Error("Subagent could not be stopped")
	}
	return Empty.create({})
}
