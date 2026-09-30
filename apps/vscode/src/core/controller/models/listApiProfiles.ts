import type { ApiConfigProfile } from "@shared/api-profiles"
import type { EmptyRequest } from "@shared/proto/cline/common"
import { ApiConfigProfile as ApiConfigProfileProto, ListApiProfilesResponse } from "@shared/proto/cline/models"
import { Logger } from "@/shared/services/Logger"
import type { Controller } from "../index"
import { type ApiProfileStore, listProfileSecretKeys, readApiConfigProfiles, readApiProfileAssignments } from "./apiProfiles"

function toProtoProfile(stateManager: ApiProfileStore, profile: ApiConfigProfile): ApiConfigProfileProto {
	return ApiConfigProfileProto.create({
		id: profile.id,
		name: profile.name,
		provider: profile.provider,
		modelId: profile.modelId,
		openAiCompatibleApiType: profile.openAiCompatibleApiType ?? "",
		optionsJson: JSON.stringify(profile.options ?? {}),
		secretKeys: listProfileSecretKeys(stateManager, profile.id),
	})
}

/**
 * Lists saved API configuration profiles and the per-mode assignments.
 */
export async function listApiProfiles(controller: Controller, _request: EmptyRequest): Promise<ListApiProfilesResponse> {
	try {
		const profiles = readApiConfigProfiles(controller.stateManager)
		const { askProfileId, actProfileId } = readApiProfileAssignments(controller.stateManager)
		return ListApiProfilesResponse.create({
			profiles: profiles.map((profile) => toProtoProfile(controller.stateManager, profile)),
			askProfileId: askProfileId ?? "",
			actProfileId: actProfileId ?? "",
		})
	} catch (error) {
		Logger.error(`Failed to list API profiles: ${error}`)
		throw error
	}
}
