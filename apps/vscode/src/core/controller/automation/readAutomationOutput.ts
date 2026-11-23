import type { ReadAutomationOutputRequest } from "@shared/proto/cline/automation"
import { String } from "@shared/proto/cline/common"
import type { Controller } from ".."

export async function readAutomationOutput(controller: Controller, request: ReadAutomationOutputRequest): Promise<String> {
	await controller.automations.runner.load()
	return String.create({ value: controller.automations.runner.outputValue(request.runId, request.stepId, request.name) })
}
