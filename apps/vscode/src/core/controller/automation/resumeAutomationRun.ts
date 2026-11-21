import { ResumeAutomationRunRequest, StartAutomationRunResponse } from "@shared/proto/cline/automation"
import { Controller } from ".."

/** Retry, Resume from a step, or Run again on a finished run's block: the user's own action. */
export async function resumeAutomationRun(
	controller: Controller,
	request: ResumeAutomationRunRequest,
): Promise<StartAutomationRunResponse> {
	await controller.getWorkspaceRoot()
	const run = await controller.automations.resume(request.runId, {
		fromStepId: request.stepId || undefined,
		fresh: request.fresh,
	})
	return StartAutomationRunResponse.create({ runId: run.id, taskGroupId: run.taskGroupId })
}
