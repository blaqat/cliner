import { ModelSettingsRequestV1, ModelSettingsResponseV1 } from "@shared/proto/cline/models"
import { readModelSettingsState } from "@/sdk/model-settings/host-settings"
import type { Controller } from ".."

export async function getModelSettings(
	controller: Controller,
	_request: ModelSettingsRequestV1,
): Promise<ModelSettingsResponseV1> {
	// Each window keeps its own copy, so a read is what brings another window's changes in.
	if (await controller.stateManager.refreshModelSettings()) void controller.postStateToWebview()
	return ModelSettingsResponseV1.create({ json: JSON.stringify(await readModelSettingsState(controller.stateManager)) })
}
