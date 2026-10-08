import { Empty } from "@shared/proto/cline/common"
import type { InterjectPromptRequest } from "@shared/proto/cline/task"
import type { Controller } from ".."

export async function interjectPrompt(controller: Controller, request: InterjectPromptRequest): Promise<Empty> {
	await controller.interjectPrompt(request.text, request.images, request.files)
	return Empty.create({})
}
