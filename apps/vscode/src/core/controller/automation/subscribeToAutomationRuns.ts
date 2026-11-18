import type { AutomationRun } from "@shared/automations"
import { AutomationRuns } from "@shared/proto/cline/automation"
import { EmptyRequest } from "@shared/proto/cline/common"
import { Logger } from "@/shared/services/Logger"
import { getRequestRegistry, StreamingResponseHandler } from "../grpc-handler"
import type { Controller } from "../index"

const subscriptions = new Set<StreamingResponseHandler<AutomationRuns>>()

/** Streams every run (live and recent) to the webview, starting with what's known now. */
export async function subscribeToAutomationRuns(
	controller: Controller,
	_request: EmptyRequest,
	responseStream: StreamingResponseHandler<AutomationRuns>,
	requestId?: string,
): Promise<void> {
	subscriptions.add(responseStream)
	if (requestId) {
		getRequestRegistry().registerRequest(
			requestId,
			() => subscriptions.delete(responseStream),
			{ type: "automation_runs_subscription" },
			responseStream,
		)
	}
	try {
		await controller.automations.runner.load()
		await responseStream(AutomationRuns.create({ runsJson: JSON.stringify(controller.automations.runner.list()) }), false)
	} catch (error) {
		Logger.error("Error sending automation runs:", error)
		subscriptions.delete(responseStream)
	}
}

/** Sends the runs to every open webview. */
export async function sendAutomationRunsEvent(runs: readonly AutomationRun[]): Promise<void> {
	const message = AutomationRuns.create({ runsJson: JSON.stringify(runs) })
	await Promise.all(
		Array.from(subscriptions).map(async (responseStream) => {
			try {
				await responseStream(message, false)
			} catch (error) {
				Logger.error("Error sending automation runs:", error)
				subscriptions.delete(responseStream)
			}
		}),
	)
}
