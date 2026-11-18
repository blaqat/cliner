import { AutomationList } from "@shared/proto/cline/automation"
import { StringRequest } from "@shared/proto/cline/common"
import { Controller } from ".."
import { buildAutomationList } from "./listAutomations"

/** Deletes an automation file the store lists (never any other path). */
export async function deleteAutomation(controller: Controller, request: StringRequest): Promise<AutomationList> {
	await controller.getWorkspaceRoot()
	await controller.automations.store.remove(request.value)
	return buildAutomationList(controller)
}
