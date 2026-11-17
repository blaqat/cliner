import { NotebookActionRequest, NotebookActionResponse } from "@shared/proto/cline/task_group"
import { validateTaskGroupIdentifier } from "@/sdk/task-groups/task-group-store"
import { Controller } from ".."

export async function notebookAction(controller: Controller, request: NotebookActionRequest): Promise<NotebookActionResponse> {
	validateTaskGroupIdentifier(request.taskGroupId, "taskGroupId")
	validateTaskGroupIdentifier(request.slug, "slug")
	return NotebookActionResponse.create({ json: JSON.stringify(await controller.notebookAction(request)) })
}
