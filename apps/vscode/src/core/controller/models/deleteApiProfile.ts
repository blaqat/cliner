import { Empty } from "@shared/proto/cline/common"
import type { DeleteApiProfileRequest } from "@shared/proto/cline/models"
import { Logger } from "@/shared/services/Logger"
import type { Controller } from "../index"
import { deleteApiConfigProfile } from "./apiProfiles"

/**
 * Deletes a saved API configuration profile and its stored secrets, and
 * replaces per-mode assignments pointing at it. Rejects the last profile.
 */
export async function deleteApiProfile(controller: Controller, request: DeleteApiProfileRequest): Promise<Empty> {
	try {
		const previous = controller.stateManager.getApiConfiguration()
		const id = request.id?.trim()
		if (!id) {
			throw new Error("profile id is required")
		}
		if (!deleteApiConfigProfile(controller.stateManager, id)) {
			throw new Error(`No saved configuration with id "${id}"`)
		}
		controller.handleApiConfigurationChanged?.(previous, controller.stateManager.getApiConfiguration())
		await controller.postStateToWebview()
		return Empty.create()
	} catch (error) {
		Logger.error(`Failed to delete API profile: ${error}`)
		throw error
	}
}
