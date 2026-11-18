import { Empty, StringRequest } from "@shared/proto/cline/common"
import { Controller } from ".."

/** Stops a run: its running threads stop, later steps are skipped, finished work stays. */
export async function stopAutomationRun(controller: Controller, request: StringRequest): Promise<Empty> {
	await controller.automations.runner.stop(request.value)
	return Empty.create({})
}
