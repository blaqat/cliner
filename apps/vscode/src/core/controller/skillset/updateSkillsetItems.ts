import { Empty } from "@shared/proto/cline/common"
import type { UpdateSkillsetItemsRequest } from "@shared/proto/cline/skillset"
import { updateItems } from "@/sdk/skills/skillset-handlers"
import type { Controller } from ".."

/** Turn on, remove or mark seen the items of an added set. */
export async function updateSkillsetItems(controller: Controller, request: UpdateSkillsetItemsRequest): Promise<Empty> {
	await updateItems(controller, { setId: request.setId, action: request.action, paths: request.paths })
	return Empty.create({})
}
