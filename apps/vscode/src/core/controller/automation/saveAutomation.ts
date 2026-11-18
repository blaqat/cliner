import { AutomationList, SaveAutomationRequest } from "@shared/proto/cline/automation"
import { parseDefinitionJson } from "@/sdk/automations/automation-json"
import { Controller } from ".."
import { buildAutomationList } from "./listAutomations"

/** The builder's Save: writes the readable file (moving it on a rename) and trusts that version. */
export async function saveAutomation(controller: Controller, request: SaveAutomationRequest): Promise<AutomationList> {
	const scope = request.scope === "global" ? "global" : "workspace"
	await controller.getWorkspaceRoot()
	const saved = await controller.automations.store.save(
		parseDefinitionJson(request.definitionJson),
		scope,
		request.previousPath || undefined,
	)
	return buildAutomationList(controller, saved.filePath)
}
