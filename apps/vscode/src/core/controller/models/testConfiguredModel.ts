import { ModelSettingsRequestV1, ModelSettingsResponseV1 } from "@shared/proto/cline/models"
import type { Controller } from ".."
import { modelSettingsDiagnostic } from "./modelSettingsDiagnostics"

export async function testConfiguredModel(
	controller: Controller,
	request: ModelSettingsRequestV1,
): Promise<ModelSettingsResponseV1> {
	return ModelSettingsResponseV1.create({
		json: JSON.stringify(await modelSettingsDiagnostic(controller, "testConfiguredModel", request.json)),
	})
}
