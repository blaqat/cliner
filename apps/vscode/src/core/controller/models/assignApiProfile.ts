import { Empty } from "@shared/proto/cline/common"
import type { AssignApiProfileRequest } from "@shared/proto/cline/models"
import { Logger } from "@/shared/services/Logger"
import type { Controller } from "../index"
import { assignApiConfigProfile } from "./apiProfiles"
import { parseModeRequest } from "./providerCatalogShared"
import { createTaskApiModelShim, resolveActiveModelIdFromApiConfiguration } from "./taskApiModel"

/**
 * Assigns a saved API configuration profile to a mode ("plan" serves Ask).
 * The profile's provider, model, options and secrets are written into that
 * mode's existing ApiConfiguration keys via `StateManager.setApiConfiguration`,
 * so downstream request code is unchanged.
 */
export async function assignApiProfile(controller: Controller, request: AssignApiProfileRequest): Promise<Empty> {
	try {
		const mode = parseModeRequest(request.mode)
		const profileId = request.profileId?.trim()
		if (!profileId) {
			throw new Error("profile_id is required")
		}

		const previousApiConfiguration = controller.stateManager.getApiConfiguration()
		assignApiConfigProfile(controller.stateManager, mode, profileId)
		await controller.stateManager.flushPendingState?.()

		const nextApiConfiguration = controller.stateManager.getApiConfiguration()

		// Refresh the task's API model shim when the assigned mode is the active one
		if (controller.task) {
			const currentMode = controller.stateManager.getGlobalSettingsKey("mode")
			if (currentMode === mode) {
				const modelId = resolveActiveModelIdFromApiConfiguration(nextApiConfiguration, currentMode)
				controller.task.api = createTaskApiModelShim(modelId)
			}
		}
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
