import { Empty, EmptyRequest } from "@shared/proto/cline/common"
import { Logger } from "@/shared/services/Logger"
import { getRequestRegistry, StreamingResponseHandler } from "../grpc-handler"
import type { Controller } from "../index"

// Keep track of active stashShortcut subscriptions
const activeStashShortcutSubscriptions = new Set<StreamingResponseHandler<Empty>>()

/**
 * Subscribe to stashShortcut events
 * @param controller The controller instance
 * @param request The empty request
 * @param responseStream The streaming response handler
 * @param requestId The ID of the request (passed by the gRPC handler)
 */
export async function subscribeToStashShortcut(
	_controller: Controller,
	_request: EmptyRequest,
	responseStream: StreamingResponseHandler<Empty>,
	requestId?: string,
): Promise<void> {
	// Add this subscription to the active subscriptions
	activeStashShortcutSubscriptions.add(responseStream)

	// Register cleanup when the connection is closed
	const cleanup = () => {
		activeStashShortcutSubscriptions.delete(responseStream)
	}

	// Register the cleanup function with the request registry if we have a requestId
	if (requestId) {
		getRequestRegistry().registerRequest(requestId, cleanup, { type: "stashShortcut_subscription" }, responseStream)
	}
}

/**
 * Send a stashShortcut event to all active subscribers
 */
export async function sendStashShortcutEvent(): Promise<void> {
	// Send the event to all active subscribers
	const promises = Array.from(activeStashShortcutSubscriptions).map(async (responseStream) => {
		try {
			const event = Empty.create({})
			await responseStream(
				event,
				false, // Not the last message
			)
		} catch (error) {
			Logger.error("Error sending stashShortcut event:", error)
			// Remove the subscription if there was an error
			activeStashShortcutSubscriptions.delete(responseStream)
		}
	})

	await Promise.all(promises)
}
