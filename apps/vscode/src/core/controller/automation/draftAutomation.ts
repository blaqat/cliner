import { DraftAutomationResponse } from "@shared/proto/cline/automation"
import { StringRequest } from "@shared/proto/cline/common"
import { DRAFT_SYSTEM_PROMPT, draftPrompt, parseDraftReply } from "@/sdk/automations/automation-draft"
import { backgroundHandler, useModelSettings } from "@/sdk/model-settings/background"
import { Controller } from ".."

/**
 * "Describe it and Cline drafts it": one model call the user started from the builder, on the model
 * Settings › Models uses for generating text. The draft opens in the builder; nothing is saved or run.
 */
export async function draftAutomation(controller: Controller, request: StringRequest): Promise<DraftAutomationResponse> {
	const description = request.value.trim()
	if (!description) throw new Error("Describe the automation first.")
	if (!useModelSettings(controller.stateManager))
		throw new Error("Drafting needs the new model settings. Set up a model in Settings › Models.")
	const handler = await backgroundHandler(controller.stateManager, "generate")
	if (!handler) throw new Error("No model is set for generating text. Pick one in Settings › Models › Background text.")
	let reply = ""
	let failure: string | undefined
	for await (const chunk of handler.createMessage(DRAFT_SYSTEM_PROMPT, [{ role: "user", content: draftPrompt(description) }])) {
		if (chunk.type === "text") reply += chunk.text
		else if (chunk.type === "done" && chunk.success === false) failure = chunk.error
	}
	if (failure) throw new Error(`The draft failed: ${failure}`)
	const draft = parseDraftReply(reply)
	return DraftAutomationResponse.create({
		definitionJson: JSON.stringify(draft.definition),
		guesses: draft.guesses,
		model: handler.getModel?.().id ?? "",
	})
}
