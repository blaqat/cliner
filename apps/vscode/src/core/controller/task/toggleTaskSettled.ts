import { Empty } from "@shared/proto/cline/common"
import type { TaskSettledRequest } from "@shared/proto/cline/task"
import type { Controller } from ".."

export async function toggleTaskSettled(controller: Controller, request: TaskSettledRequest): Promise<Empty> {
	if (!request.taskId) throw new Error("taskId is required")
	await controller.toggleTaskSettled(request.taskId)
	return Empty.create({})
}
