import { MessageLinkInfo, ResolveMessageLinkRequest } from "@shared/proto/cline/task"
import { Controller } from ".."

/**
 * Resolves a message deep link back to its message for the composer's
 * paste -> quote chip. Returns the single message's text — never the thread.
 * An empty `text` means the target couldn't be found, so the composer falls
 * back to inserting the URL literally.
 */
export async function resolveMessageLink(controller: Controller, request: ResolveMessageLinkRequest): Promise<MessageLinkInfo> {
	if (!request.threadId) {
		throw new Error("thread_id is required")
	}
	const info = await controller.resolveMessageLink(request.threadId, request.messageIndex, {
		toolCallId: request.toolCallId,
		block: request.block,
	})
	return MessageLinkInfo.create(info)
}
