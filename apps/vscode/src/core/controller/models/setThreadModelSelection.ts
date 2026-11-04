import { ModelPickSchema } from "@shared/model-settings"
import { ModelSettingsRequestV1, ModelSettingsResponseV1 } from "@shared/proto/cline/models"
import { z } from "zod"
import type { Controller } from ".."

export const ThreadSelectionRequestSchema = z
	.object({
		taskId: z.string(),
		mode: z.enum(["plan", "act"]),
		pick: ModelPickSchema,
		nextMessageOnly: z.boolean(),
	})
	.strict()

export async function setThreadModelSelection(
	controller: Controller,
	request: ModelSettingsRequestV1,
): Promise<ModelSettingsResponseV1> {
	const input = ThreadSelectionRequestSchema.parse(JSON.parse(request.json))
	await controller.setConfiguredThreadSelection(input)
	return ModelSettingsResponseV1.create({ json: JSON.stringify({ applied: true }) })
}
