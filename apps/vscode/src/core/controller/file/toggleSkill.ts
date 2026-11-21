import { setInstructionFileToggle } from "@core/context/instructions/user-instructions/file-toggles"
import { SkillsToggles, ToggleSkillRequest } from "@shared/proto/cline/file"
import { Logger } from "@/shared/services/Logger"
import { Controller } from ".."

/**
 * Toggles a skill on or off
 * @param controller The controller instance
 * @param request The request containing the skill path and enabled state
 * @returns The updated skills toggles
 */
export async function toggleSkill(controller: Controller, request: ToggleSkillRequest): Promise<SkillsToggles> {
	const { skillPath, isGlobal, enabled } = request

	if (!skillPath || typeof enabled !== "boolean" || typeof isGlobal !== "boolean") {
		Logger.error("toggleSkill: Missing or invalid parameters", {
			skillPath,
			isGlobal,
			enabled: typeof enabled === "boolean" ? enabled : `Invalid: ${typeof enabled}`,
		})
		throw new Error("Missing or invalid parameters for toggleSkill")
	}

	const state = controller.stateManager

	// Remote skills are identified by a "remote:" path prefix. They use a separate toggle store
	// keyed by skill name (the part after "remote:") rather than the file path.
	if (skillPath.startsWith("remote:")) {
		const name = skillPath.replace("remote:", "")
		state.setGlobalState("remoteSkillsToggles", { ...state.getGlobalStateKey("remoteSkillsToggles"), [name]: enabled })
		await state.flushPendingState()
	} else {
		await setInstructionFileToggle(state, "skill", skillPath, isGlobal, enabled)
	}

	await controller.postStateToWebview()

	return SkillsToggles.create({
		globalSkillsToggles: state.getGlobalSettingsKey("globalSkillsToggles"),
		localSkillsToggles: state.getWorkspaceStateKey("localSkillsToggles"),
		remoteSkillsToggles: state.getGlobalStateKey("remoteSkillsToggles"),
	})
}
