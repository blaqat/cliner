import { ModelSettingsRequestV1, ModelSettingsResponseV1 } from "@shared/proto/cline/models"
import { readModelSettingsState } from "@/sdk/model-settings/host-settings"
import type { Controller } from ".."

export async function getModelSettings(
	controller: Controller,
	_request: ModelSettingsRequestV1,
): Promise<ModelSettingsResponseV1> {
	return ModelSettingsResponseV1.create({ json: JSON.stringify(await readModelSettingsState(controller.stateManager)) })
}
