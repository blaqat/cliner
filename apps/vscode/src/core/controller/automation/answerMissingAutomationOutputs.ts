import type { AnswerMissingAutomationOutputsRequest } from "@shared/proto/cline/automation"
import { Empty } from "@shared/proto/cline/common"
import type { Controller } from ".."

export async function answerMissingAutomationOutputs(
	controller: Controller,
	request: AnswerMissingAutomationOutputsRequest,
): Promise<Empty> {
	await controller.automations.runner.answerMissingOutputs(request.runId, request.threadId, request.askAgain)
	return Empty.create({})
}
