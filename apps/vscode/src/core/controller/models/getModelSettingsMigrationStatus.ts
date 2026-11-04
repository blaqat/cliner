import { ModelSettingsRequestV1, ModelSettingsResponseV1 } from "@shared/proto/cline/models"
import type { Controller } from ".."

export async function getModelSettingsMigrationStatus(
	controller: Controller,
	_request: ModelSettingsRequestV1,
): Promise<ModelSettingsResponseV1> {
	return ModelSettingsResponseV1.create({ json: JSON.stringify(controller.stateManager.getModelSettingsMigrationStatus()) })
}
