import { Empty } from "@shared/proto/cline/common"
import type { TaskSettledRequest } from "@shared/proto/cline/task"
import type { Controller } from ".."

export async function toggleTaskStashed(controller: Controller, request: TaskSettledRequest): Promise<Empty> {
	if (request.taskIds.length) {
		if (request.value === undefined) throw new Error("value is required for a bulk state switch")
		await controller.setTasksStashed(request.taskIds, request.value)
	} else {
		if (!request.taskId) throw new Error("taskId is required")
		await controller.toggleTaskStashed(request.taskId)
	}
	return Empty.create({})
}
