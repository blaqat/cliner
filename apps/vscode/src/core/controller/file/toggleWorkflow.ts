import { setInstructionFileToggle } from "@core/context/instructions/user-instructions/file-toggles"
import { ClineRulesToggles, RuleScope, ToggleWorkflowRequest } from "@shared/proto/cline/file"
import { Logger } from "@/shared/services/Logger"
import { Controller } from ".."

/**
 * Toggles a workflow on or off
 * @param controller The controller instance
 * @param request The request containing the workflow path and enabled state
 * @returns The updated workflow toggles
 */
export async function toggleWorkflow(controller: Controller, request: ToggleWorkflowRequest): Promise<ClineRulesToggles> {
	const { workflowPath, enabled, scope } = request

	if (!workflowPath || typeof enabled !== "boolean" || scope === undefined) {
		Logger.error("toggleWorkflow: Missing or invalid parameters", {
			workflowPath,
			scope,
			enabled: typeof enabled === "boolean" ? enabled : `Invalid: ${typeof enabled}`,
		})
		throw new Error("Missing or invalid parameters for toggleWorkflow")
	}

	const state = controller.stateManager
	let toggles: Record<string, boolean>
	switch (scope) {
		case RuleScope.GLOBAL:
		case RuleScope.LOCAL:
			toggles = await setInstructionFileToggle(state, "workflow", workflowPath, scope === RuleScope.GLOBAL, enabled)
			break
		case RuleScope.REMOTE: {
			toggles = { ...state.getGlobalStateKey("remoteWorkflowToggles"), [workflowPath]: enabled }
			state.setGlobalState("remoteWorkflowToggles", toggles)
			await state.flushPendingState()
			break
		}
		default:
			throw new Error(`Invalid scope: ${scope}`)
	}

	await controller.postStateToWebview()

	return ClineRulesToggles.create({ toggles })
}
