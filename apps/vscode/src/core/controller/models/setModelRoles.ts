import { ModelSettingsRequestV1, ModelSettingsResponseV1 } from "@shared/proto/cline/models"
import type { Controller } from ".."
import { mutateSettings } from "./modelSettingsRpc"

export async function setModelRoles(controller: Controller, request: ModelSettingsRequestV1): Promise<ModelSettingsResponseV1> {
	return ModelSettingsResponseV1.create({
		json: JSON.stringify(await mutateSettings(controller, "setModelRoles", request.json)),
	})
}
