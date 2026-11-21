import { DraftAutomationResponse } from "@shared/proto/cline/automation"
import { StringRequest } from "@shared/proto/cline/common"
import { Controller } from ".."

/** "Save this task as an automation" on a task page: the draft opens in the builder; nothing is saved. */
export async function draftAutomationFromTask(controller: Controller, request: StringRequest): Promise<DraftAutomationResponse> {
	const draft = await controller.draftAutomationFromTask(request.value)
	return DraftAutomationResponse.create({ definitionJson: JSON.stringify(draft.definition), guesses: draft.guesses })
}
