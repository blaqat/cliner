import type { EmptyRequest } from "@shared/proto/cline/common"
import { SkillsetJson } from "@shared/proto/cline/skillset"
import { pickAndImportSkillset } from "@/sdk/skills/skillset-handlers"
import type { Controller } from ".."

/** Skills › Add skillset…: the open dialog, then the import. */
export async function pickSkillset(controller: Controller, _request: EmptyRequest): Promise<SkillsetJson> {
	return SkillsetJson.create({ json: JSON.stringify(await pickAndImportSkillset(controller)) })
}
