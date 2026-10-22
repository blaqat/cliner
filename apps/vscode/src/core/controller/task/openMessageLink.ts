import { Empty } from "@shared/proto/cline/common"
import type { ResolveMessageLinkRequest } from "@shared/proto/cline/task"
import { Controller } from ".."

/**
 * Opens a linked message from the webview (a message tag on a sent message):
 * shows its thread scrolled to the message, the same as opening its vscode:// link.
 */
export async function openMessageLink(controller: Controller, request: ResolveMessageLinkRequest): Promise<Empty> {
	if (!request.threadId) {
		throw new Error("thread_id is required")
	}
	await controller.openMessageLink(request.threadId, request.messageIndex, {
		toolCallId: request.toolCallId,
		block: request.block,
	})
	return Empty.create()
}
