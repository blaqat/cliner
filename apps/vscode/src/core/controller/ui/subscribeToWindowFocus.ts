import { Boolean, EmptyRequest } from "@shared/proto/cline/common"
import { Logger } from "@/shared/services/Logger"
import { getRequestRegistry, StreamingResponseHandler } from "../grpc-handler"
import type { Controller } from "../index"

const windowFocusSubscriptions = new Set<StreamingResponseHandler<Boolean>>()

// The webview can't see VS Code's window focus (its own document focus only
// tracks the sidebar), so the host keeps the last known state and pushes changes.
let windowFocused = true

/** Streams VS Code window focus to the webview, starting with the current state. */
export async function subscribeToWindowFocus(
	_controller: Controller,
	_request: EmptyRequest,
	responseStream: StreamingResponseHandler<Boolean>,
	requestId?: string,
): Promise<void> {
	windowFocusSubscriptions.add(responseStream)
	const cleanup = () => {
		windowFocusSubscriptions.delete(responseStream)
	}
	if (requestId) {
		getRequestRegistry().registerRequest(requestId, cleanup, { type: "window_focus_subscription" }, responseStream)
	}
	try {
		await responseStream(Boolean.create({ value: windowFocused }), false)
	} catch (error) {
		Logger.error("Error sending initial window focus:", error)
		windowFocusSubscriptions.delete(responseStream)
	}
}

/** Records the window focus state and sends it to every subscriber when it changes. */
export async function sendWindowFocusEvent(focused: boolean): Promise<void> {
	if (focused === windowFocused) return
	windowFocused = focused
	const promises = Array.from(windowFocusSubscriptions).map(async (responseStream) => {
		try {
			await responseStream(Boolean.create({ value: focused }), false)
		} catch (error) {
			Logger.error("Error sending window focus event:", error)
			windowFocusSubscriptions.delete(responseStream)
		}
	})
	await Promise.all(promises)
}
