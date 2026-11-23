import { AutomationCheck, CheckAutomationRunRequest } from "@shared/proto/cline/automation"
import { Controller } from ".."

/** What must be fixed before starting or resuming a run. */
export async function checkAutomationRun(controller: Controller, request: CheckAutomationRunRequest): Promise<AutomationCheck> {
	await controller.getWorkspaceRoot()
	const problems = await controller.automations.check(request.value, request)
	return AutomationCheck.create({ problemsJson: JSON.stringify(problems) })
}
