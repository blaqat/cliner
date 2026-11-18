import { AutomationList, TrustAutomationRequest } from "@shared/proto/cline/automation"
import { Controller } from ".."
import { buildAutomationList } from "./listAutomations"

/** "Review and trust": trusts the file only if it is still the version the user looked at. */
export async function trustAutomation(controller: Controller, request: TrustAutomationRequest): Promise<AutomationList> {
	await controller.getWorkspaceRoot()
	await controller.automations.store.trustVersion(request.path, request.fingerprint)
	return buildAutomationList(controller)
}
