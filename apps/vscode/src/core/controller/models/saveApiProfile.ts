import {
	ApiConfigProfile as ApiConfigProfileProto,
	SaveApiProfileRequest,
	SaveApiProfileResponse,
} from "@shared/proto/cline/models"
import { Logger } from "@/shared/services/Logger"
import type { Controller } from "../index"
import { listProfileSecretKeys, upsertApiConfigProfile } from "./apiProfiles"

/**
 * Creates or updates a saved API configuration profile. Any `secrets` entries
 * are stored under `profile:<id>:<secretKey>` in secret storage.
 */
export async function saveApiProfile(controller: Controller, request: SaveApiProfileRequest): Promise<SaveApiProfileResponse> {
	try {
		const previous = controller.stateManager.getApiConfiguration()
		let options: Record<string, unknown> | undefined
		if (request.optionsJson) {
			const parsed = JSON.parse(request.optionsJson)
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				options = parsed
			}
		}

		const profile = upsertApiConfigProfile(controller.stateManager, {
			id: request.id || undefined,
			name: request.name,
			provider: request.provider,
			modelId: request.modelId,
			openAiCompatibleApiType: request.openAiCompatibleApiType || undefined,
			options,
			secrets: request.secrets,
		})

		controller.handleApiConfigurationChanged?.(previous, controller.stateManager.getApiConfiguration())
		await controller.postStateToWebview()

		return SaveApiProfileResponse.create({
			profile: ApiConfigProfileProto.create({
				id: profile.id,
				name: profile.name,
				provider: profile.provider,
				modelId: profile.modelId,
				openAiCompatibleApiType: profile.openAiCompatibleApiType ?? "",
				optionsJson: JSON.stringify(profile.options ?? {}),
				secretKeys: listProfileSecretKeys(controller.stateManager, profile.id),
			}),
		})
	} catch (error) {
		Logger.error(`Failed to save API profile: ${error}`)
		throw error
	}
}
