import { RefreshedScripts, ToggleScriptRequest } from "@shared/proto/cline/file"
import { Logger } from "@/shared/services/Logger"
import { Controller } from ".."
import { buildRefreshedScripts } from "./refreshScripts"

/** Toggles a script on or off; off scripts leave the agent's index and the slash menu. */
export async function toggleScript(controller: Controller, request: ToggleScriptRequest): Promise<RefreshedScripts> {
	const { scriptPath, isGlobal, enabled } = request
	if (!scriptPath || typeof enabled !== "boolean" || typeof isGlobal !== "boolean") {
		Logger.error("toggleScript: Missing or invalid parameters", { scriptPath, isGlobal, enabled })
		throw new Error("Missing or invalid parameters for toggleScript")
	}
	if (isGlobal) {
		const toggles = controller.stateManager.getGlobalSettingsKey("globalScriptToggles") || {}
		controller.stateManager.setGlobalState("globalScriptToggles", { ...toggles, [scriptPath]: enabled })
	} else {
		const toggles = controller.stateManager.getWorkspaceStateKey("scriptToggles") || {}
		controller.stateManager.setWorkspaceState("scriptToggles", { ...toggles, [scriptPath]: enabled })
	}
	return buildRefreshedScripts(controller)
}
