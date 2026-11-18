import { AnswerAutomationCheckpointRequest } from "@shared/proto/cline/automation"
import { Empty } from "@shared/proto/cline/common"
import { Controller } from ".."

/** The user's pick at a run's "Ask you" step. */
export async function answerAutomationCheckpoint(
	controller: Controller,
	request: AnswerAutomationCheckpointRequest,
): Promise<Empty> {
	controller.automations.runner.answer(request.runId, request.stepId, request.choice)
	return Empty.create({})
}
