import { ModelSettingsRequestV1, ModelSettingsResponseV1 } from "@shared/proto/cline/models"
import type { Controller } from ".."

export async function retryModelSettingsMigration(
	controller: Controller,
	_request: ModelSettingsRequestV1,
): Promise<ModelSettingsResponseV1> {
	await controller.stateManager.retryModelSettingsMigration()
	await controller.postStateToWebview()
	return ModelSettingsResponseV1.create({ json: JSON.stringify(controller.stateManager.getModelSettingsMigrationStatus()) })
}
