import type { ListSkillsetLibraryRequest } from "@shared/proto/cline/skillset"
import { SkillsetJson } from "@shared/proto/cline/skillset"
import { listLibrary } from "@/sdk/skills/skillset-handlers"
import type { Controller } from ".."

/** Skills and workflows with their files, and the added sets. */
export async function listSkillsetLibrary(controller: Controller, request: ListSkillsetLibraryRequest): Promise<SkillsetJson> {
	return SkillsetJson.create({ json: JSON.stringify(await listLibrary(controller, request.includeFiles)) })
}
