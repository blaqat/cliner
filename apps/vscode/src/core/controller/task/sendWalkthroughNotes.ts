import { Empty, type StringRequest } from "@shared/proto/cline/common"
import type { WalkthroughRequest } from "@shared/Walkthrough"
import { walkthroughService } from "@/services/walkthrough/service"
import type { Controller } from ".."

export async function sendWalkthroughNotes(controller: Controller, request: StringRequest): Promise<Empty> {
	const input = JSON.parse(request.value) as WalkthroughRequest
	await walkthroughService(controller).sendNotes(input)
	return Empty.create()
}
