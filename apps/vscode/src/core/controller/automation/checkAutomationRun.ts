import { AutomationCheck } from "@shared/proto/cline/automation"
import { StringRequest } from "@shared/proto/cline/common"
import { Controller } from ".."

/** What must be fixed before `/name` can run, so the start form says it before Run. */
export async function checkAutomationRun(controller: Controller, request: StringRequest): Promise<AutomationCheck> {
	await controller.getWorkspaceRoot()
	const problems = await controller.automations.check(request.value)
	return AutomationCheck.create({ problemsJson: JSON.stringify(problems) })
}
