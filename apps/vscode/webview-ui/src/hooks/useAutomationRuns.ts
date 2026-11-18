import type { AutomationRun } from "@shared/automations"
import { EmptyRequest } from "@shared/proto/cline/common"
import { useEffect, useSyncExternalStore } from "react"
import { AutomationServiceClient } from "@/services/grpc-client"

let runs: readonly AutomationRun[] = []
const listeners = new Set<() => void>()
let unsubscribe: (() => void) | undefined
let users = 0

function publish(next: readonly AutomationRun[]): void {
	runs = next
	for (const listener of listeners) listener()
}

function subscribe(): void {
	unsubscribe = AutomationServiceClient.subscribeToAutomationRuns(EmptyRequest.create({}), {
		onResponse: (response) => {
			try {
				const parsed = JSON.parse(response.runsJson || "[]")
				if (Array.isArray(parsed)) publish(parsed as AutomationRun[])
			} catch {
				// Keep the last runs.
			}
		},
		onError: (error) => console.error("Error in automation runs subscription:", error),
		onComplete: () => {},
	})
}

/** Every run the host knows (live and recent), kept current by one shared subscription. */
export function useAutomationRuns(): readonly AutomationRun[] {
	useEffect(() => {
		users++
		if (users === 1) subscribe()
		return () => {
			users--
			if (users === 0) {
				unsubscribe?.()
				unsubscribe = undefined
			}
		}
	}, [])
	return useSyncExternalStore(
		(listener) => {
			listeners.add(listener)
			return () => listeners.delete(listener)
		},
		() => runs,
	)
}

/** Test helper: replaces the runs every hook sees. */
export function setAutomationRunsForTest(next: readonly AutomationRun[]): void {
	publish(next)
}
