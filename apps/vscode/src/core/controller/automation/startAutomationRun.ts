import { StartAutomationRunRequest, StartAutomationRunResponse } from "@shared/proto/cline/automation"
import { Controller } from ".."

/**
 * The composer's Run on a `/name` draft: the user's own action, so its model calls are allowed. Agents
 * have no tool that reaches this.
 */
export async function startAutomationRun(
	controller: Controller,
	request: StartAutomationRunRequest,
): Promise<StartAutomationRunResponse> {
	await controller.getWorkspaceRoot()
	const run = await controller.automations.start(request.name, request.values ?? {}, {
		taskGroupId: request.taskGroupId || undefined,
		fingerprint: request.fingerprint,
	})
	return StartAutomationRunResponse.create({ runId: run.id, taskGroupId: run.taskGroupId })
}
