import { Int64Request, String } from "@shared/proto/cline/common"
import { Controller } from ".."

/**
 * Why Reset Code can't restore the workspace from the user message with the given ts although a
 * checkpoint exists, such as a worktree other threads share. Empty when nothing blocks it. The webview
 * asks only after checkpointExistsForMessage says no, so the button can say why.
 */
export async function checkpointRestoreBlockForMessage(controller: Controller, request: Int64Request): Promise<String> {
	return String.create({ value: await controller.workspaceRestoreBlockForMessage(request.value) })
}
