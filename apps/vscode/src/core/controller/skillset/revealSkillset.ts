import { Empty, type StringRequest } from "@shared/proto/cline/common"
import { revealSkillset as reveal } from "@/sdk/skills/skillset-handlers"
import type { Controller } from ".."

/** Shows a saved skillset in Finder / Explorer. */
export async function revealSkillset(_controller: Controller, request: StringRequest): Promise<Empty> {
	await reveal(request.value)
	return Empty.create({})
}
