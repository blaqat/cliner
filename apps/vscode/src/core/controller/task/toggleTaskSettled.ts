import { Empty } from "@shared/proto/cline/common"
import type { TaskSettledRequest } from "@shared/proto/cline/task"
import type { Controller } from ".."

export async function toggleTaskSettled(controller: Controller, request: TaskSettledRequest): Promise<Empty> {
	if (request.taskIds.length) {
		if (request.value === undefined) throw new Error("value is required for a bulk state switch")
		await controller.setTasksSettled(request.taskIds, request.value)
	} else {
		if (!request.taskId) throw new Error("taskId is required")
		await controller.toggleTaskSettled(request.taskId)
	}
	return Empty.create({})
}
