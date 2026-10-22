import { Empty } from "@shared/proto/cline/common"
import type { AssignApiProfileRequest } from "@shared/proto/cline/models"
import { Logger } from "@/shared/services/Logger"
import type { Controller } from "../index"
import { assignApiConfigProfile } from "./apiProfiles"
import { adoptConfigurationAsThreadDefault, applyThreadDefaultProfiles } from "./modelProfiles"
import { parseModeRequest } from "./providerCatalogShared"

/**
 * Assigns a saved API configuration profile to a mode ("plan" serves Ask).
 * The Settings branch also makes it the Thread default profile for that mode.
 * The profile's provider, model, options and secrets are written into that
 * mode's existing ApiConfiguration keys via `StateManager.setApiConfiguration`,
 * so downstream request code is unchanged.
 */
export async function assignApiProfile(controller: Controller, request: AssignApiProfileRequest): Promise<Empty> {
	try {
		const mode = parseModeRequest(request.mode)
		if (request.chatOverride) {
			await controller.updateChatApiSelection(mode, request)
			await controller.postStateToWebview()
			return Empty.create()
		}
		const profileId = request.profileId?.trim()
		if (!profileId) {
			throw new Error("profile_id is required")
		}

		const previousApiConfiguration = controller.stateManager.getApiConfiguration()
		assignApiConfigProfile(controller.stateManager, mode, profileId)
		// Settings-side assignment (onboarding) sets what new threads start on,
		// which now lives in the Thread default profile.
		adoptConfigurationAsThreadDefault(controller.stateManager, mode, profileId)
		applyThreadDefaultProfiles(controller.stateManager)
		await controller.stateManager.flushPendingState?.()

		const nextApiConfiguration = controller.stateManager.getApiConfiguration()

		controller.handleApiConfigurationChanged?.(previousApiConfiguration, nextApiConfiguration, {
			[mode === "plan" ? "askProfileId" : "actProfileId"]: profileId,
			[`${mode}ModeReasoningEffort`]: nextApiConfiguration[`${mode}ModeReasoningEffort`],
		})

		await controller.postStateToWebview()
		return Empty.create()
	} catch (error) {
		Logger.error(`Failed to assign API profile: ${error}`)
		throw error
	}
}
