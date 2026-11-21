import type { ImportSkillsetRequest } from "@shared/proto/cline/skillset"
import { SkillsetJson } from "@shared/proto/cline/skillset"
import { importDroppedSkillset } from "@/sdk/skills/skillset-handlers"
import type { Controller } from ".."

/** Adds a skillset dropped on the panel. */
export async function importSkillset(controller: Controller, request: ImportSkillsetRequest): Promise<SkillsetJson> {
	const result = await importDroppedSkillset(controller, {
		fileName: request.fileName,
		dataBase64: request.dataBase64 || undefined,
		uri: request.uri || undefined,
	})
	return SkillsetJson.create({ json: JSON.stringify(result) })
}
