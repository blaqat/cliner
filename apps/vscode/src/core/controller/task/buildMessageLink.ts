import { BuildMessageLinkRequest, MessageLink } from "@shared/proto/cline/task"
import { Controller } from ".."

/**
 * Builds the vscode:// deep link for a rendered chat row ("Copy link"). The
 * row's minted ts is resolved to the stable SDK transcript index so the link
 * keeps working after the thread re-renders.
 */
export async function buildMessageLink(controller: Controller, request: BuildMessageLinkRequest): Promise<MessageLink> {
	if (!request.threadId) {
		throw new Error("thread_id is required")
	}
	return MessageLink.create({ url: await controller.buildMessageLink(request.threadId, request.messageTs) })
}
