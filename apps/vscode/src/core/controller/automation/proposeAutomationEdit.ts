import { ProposeAutomationEditRequest, ProposeAutomationEditResponse } from "@shared/proto/cline/automation"
import { structuredPatch } from "diff"
import { EDIT_SYSTEM_PROMPT, editPrompt, readDraftText } from "@/sdk/automations/automation-draft"
import { parseAutomationFile, serializeAutomation } from "@/sdk/automations/automation-file"
import { parseDefinitionJson } from "@/sdk/automations/automation-json"
import { Controller } from ".."
import { generateAutomationFile } from "./draftAutomation"

export async function proposeAutomationEdit(
	controller: Controller,
	request: ProposeAutomationEditRequest,
): Promise<ProposeAutomationEditResponse> {
	if (!request.request.trim()) throw new Error("Describe what to change first.")
	await controller.getWorkspaceRoot()
	const current = await controller.automations.store.findByPath(request.path)
	if (!current) throw new Error("This automation file is gone.")
	const fingerprint = request.editorDefinitionJson ? request.editorBaseFingerprint : current.fingerprint
	if (!fingerprint) throw new Error("The editor's original version is unavailable. Propose again from disk.")
	const base = request.editorDefinitionJson
		? serializeAutomation(parseDefinitionJson(request.editorDefinitionJson))
		: current.content
	const { reply } = await generateAutomationFile(controller, EDIT_SYSTEM_PROMPT, editPrompt(base, request.request))
	const { text, guesses } = readDraftText(reply)
	const proposal = parseAutomationFile(text, current.name)
	const { hunks } = structuredPatch(current.name, proposal.name, base, text, "", "", { context: 2 })
	return ProposeAutomationEditResponse.create({
		fingerprint,
		proposedFile: text,
		diff: hunks
			.flatMap((hunk) => [`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`, ...hunk.lines])
			.join("\n"),
		errors: proposal.errors,
		guesses,
	})
}
