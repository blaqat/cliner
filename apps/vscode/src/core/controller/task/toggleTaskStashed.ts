import { Empty } from "@shared/proto/cline/common"
import type { TaskSettledRequest } from "@shared/proto/cline/task"
import type { Controller } from ".."

export async function toggleTaskStashed(controller: Controller, request: TaskSettledRequest): Promise<Empty> {
	if (!request.taskId) throw new Error("taskId is required")
	await controller.toggleTaskStashed(request.taskId)
	return Empty.create({})
}
