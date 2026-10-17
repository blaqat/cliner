import type { EmptyRequest } from "@shared/proto/cline/common"
import { OpenMessageEvent } from "@shared/proto/cline/ui"
import { Logger } from "@/shared/services/Logger"
import { getRequestRegistry, type StreamingResponseHandler } from "../grpc-handler"
import type { Controller } from "../index"

// Keep track of active open-message subscriptions
const openMessageSubscriptions = new Set<StreamingResponseHandler<OpenMessageEvent>>()

/**
 * Subscribe to openMessage events (a vscode:// message deep link was opened)
 */
export async function subscribeToOpenMessage(
	_controller: Controller,
	_request: EmptyRequest,
	responseStream: StreamingResponseHandler<OpenMessageEvent>,
	requestId?: string,
): Promise<void> {
	openMessageSubscriptions.add(responseStream)

	const cleanup = () => {
		openMessageSubscriptions.delete(responseStream)
	}

	if (requestId) {
		getRequestRegistry().registerRequest(requestId, cleanup, { type: "open_message_subscription" }, responseStream)
	}
}

/**
 * Send an openMessage event to all active subscribers
 */
export async function sendOpenMessageEvent(threadId: string, messageIndex: number, text: string): Promise<void> {
	const promises = Array.from(openMessageSubscriptions).map(async (responseStream) => {
		try {
			const event: OpenMessageEvent = { threadId, messageIndex, text }
			await responseStream(event, false)
		} catch (error) {
			Logger.error("Error sending openMessage event:", error)
			openMessageSubscriptions.delete(responseStream)
		}
	})

	await Promise.all(promises)
}
