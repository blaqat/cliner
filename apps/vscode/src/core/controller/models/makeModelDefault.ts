import { ModelSettingsRequestV1, ModelSettingsResponseV1 } from "@shared/proto/cline/models"
import type { Controller } from ".."
import { DependencyError, mutateSettings } from "./modelSettingsRpc"

export async function makeModelDefault(
	controller: Controller,
	request: ModelSettingsRequestV1,
): Promise<ModelSettingsResponseV1> {
	try {
		return ModelSettingsResponseV1.create({
			json: JSON.stringify(await mutateSettings(controller, "makeModelDefault", request.json)),
		})
	} catch (error) {
		if (error instanceof DependencyError)
			return ModelSettingsResponseV1.create({ json: JSON.stringify({ dependencies: error.dependencies }) })
		throw error
	}
}
