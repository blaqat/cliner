import { String, type StringRequest } from "@shared/proto/cline/common"
import type { WalkthroughAskRequest } from "@shared/Walkthrough"
import { walkthroughService } from "@/services/walkthrough/service"
import type { Controller } from ".."

export async function askWalkthrough(controller: Controller, request: StringRequest): Promise<String> {
	const result = await walkthroughService(controller).ask(JSON.parse(request.value) as WalkthroughAskRequest)
	return String.create({ value: JSON.stringify(result) })
}
