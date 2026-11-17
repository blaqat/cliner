import { ModelSettingsRequestV1, ModelSettingsResponseV1 } from "@shared/proto/cline/models"
import type { Controller } from ".."
import { savedThreadUsage } from "./modelSettingsRpc"

export async function getModelSavedThreadUsage(
	controller: Controller,
	request: ModelSettingsRequestV1,
): Promise<ModelSettingsResponseV1> {
	return ModelSettingsResponseV1.create({ json: JSON.stringify(await savedThreadUsage(controller, request.json)) })
}
