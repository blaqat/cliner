import { EmptyRequest } from "@shared/proto/cline/common"
import { State } from "@shared/proto/cline/state"
import { telemetryService } from "@/services/telemetry"
import type { ExtensionStateUpdate } from "@/shared/ExtensionMessage"
import { Logger } from "@/shared/services/Logger"
import { getRequestRegistry, StreamingResponseHandler } from "../grpc-handler"
import { Controller } from "../index"

// Keep track of active state subscriptions
interface StateSubscription {
	stream: StreamingResponseHandler<State>
	pending: Promise<void>
	historyVersion?: string
	// Live statuses/counts can change independently of the persisted history.
	derived: Partial<Record<"sessionStatuses" | "subagentCounts" | "taskGroups", string>>
}
const activeStateSubscriptions = new Map<StreamingResponseHandler<State>, StateSubscription>()

function deliver(subscription: StateSubscription, snapshot: ExtensionStateUpdate | Promise<ExtensionStateUpdate>): Promise<void> {
	subscription.pending = subscription.pending
		.then(async () => {
			if (activeStateSubscriptions.get(subscription.stream) !== subscription) return
			const state = await snapshot
			const update = { ...state }
			const version = state.taskHistoryVersion
			if (version !== undefined && version === subscription.historyVersion) delete update.taskHistory
			const derived = { ...subscription.derived }
			for (const key of ["sessionStatuses", "subagentCounts", "taskGroups"] as const) {
				if (state[key] === undefined) continue
				const json = JSON.stringify(state[key])
				if (version !== undefined && json === derived[key]) delete update[key]
				derived[key] = json
			}
			const stateJson = JSON.stringify(update)
			recordStateSizeTelemetry(Buffer.byteLength(stateJson, "utf8"))
			await subscription.stream({ stateJson }, false)
			// Advance only after delivery succeeds. A partial post cannot establish history.
			if (state.taskHistory !== undefined) subscription.historyVersion = version
			subscription.derived = derived
		})
		.catch((error) => {
			Logger.error("Error sending state update:", error)
			activeStateSubscriptions.delete(subscription.stream)
		})
	return subscription.pending
}

/**
 * Subscribe to state updates
 * @param controller The controller instance
 * @param request The empty request
 * @param responseStream The streaming response handler
 * @param requestId The ID of the request (passed by the gRPC handler)
 */
export async function subscribeToState(
	controller: Controller,
	_request: EmptyRequest,
	responseStream: StreamingResponseHandler<State>,
	requestId?: string,
): Promise<void> {
	// Add this subscription to the active subscriptions
	const subscription: StateSubscription = { stream: responseStream, pending: Promise.resolve(), derived: {} }
	activeStateSubscriptions.set(responseStream, subscription)

	// Register cleanup when the connection is closed
	const cleanup = () => {
		activeStateSubscriptions.delete(responseStream)
	}

	// Register the cleanup function with the request registry if we have a requestId
	if (requestId) {
		getRequestRegistry().registerRequest(requestId, cleanup, { type: "state_subscription" }, responseStream)
	}

	// Send the initial state
	await deliver(subscription, controller.getStateToPostToWebview())
}

/**
 * Send a state update to all active subscribers
 * @param state The state to send
 */
export async function sendStateUpdate(state: ExtensionStateUpdate): Promise<void> {
	// Queue independently per subscription; a hidden panel must not block settings RPCs.
	for (const subscription of activeStateSubscriptions.values()) {
		void deliver(subscription, state)
	}
}

function recordStateSizeTelemetry(sizeBytes: number): void {
	telemetryService.captureGrpcResponseSize(sizeBytes, "cline.StateService", "subscribeToState")
}
