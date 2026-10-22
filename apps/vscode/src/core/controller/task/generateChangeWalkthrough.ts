import { String, type StringRequest } from "@shared/proto/cline/common"
import type { WalkthroughRequest } from "@shared/Walkthrough"
import { walkthroughService } from "@/services/walkthrough/service"
import type { Controller } from ".."

export async function generateChangeWalkthrough(controller: Controller, request: StringRequest): Promise<String> {
	const input = JSON.parse(request.value) as WalkthroughRequest
	const result = await walkthroughService(controller).generate(input)
	return String.create({ value: JSON.stringify(result) })
}
