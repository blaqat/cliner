import { EmptyRequest } from "@shared/proto/cline/common"
import { TaskGroupSummaryList } from "@shared/proto/cline/task_group"
import { Controller } from ".."
import { taskGroupSummaryToProto } from "./conversions"

/**
 * Lists all task groups with note counts.
 * @param controller The controller instance
 * @param _request Empty request
 * @returns TaskGroupSummaryList with every task group
 */
export async function listTaskGroups(controller: Controller, _request: EmptyRequest): Promise<TaskGroupSummaryList> {
	const groups = await controller.listTaskGroups()
	return TaskGroupSummaryList.create({ taskGroups: groups.map(taskGroupSummaryToProto) })
}
