import { useSyncExternalStore } from "react"

/** What the builder page shows: a saved file, a blank automation, or the describe-it box first. */
export interface AutomationBuilderTarget {
	path?: string
	describe?: boolean
}

let target: AutomationBuilderTarget | null = null
const listeners = new Set<() => void>()

function publish(next: AutomationBuilderTarget | null): void {
	target = next
	for (const listener of listeners) listener()
}

/** Opens the builder in the sidebar (it replaces the chat until closed, like the notebook page). */
export function openAutomationBuilder(next: AutomationBuilderTarget = {}): void {
	publish({ ...next })
}

export function closeAutomationBuilder(): void {
	if (target) publish(null)
}

export function useAutomationBuilderTarget(): AutomationBuilderTarget | null {
	return useSyncExternalStore(
		(listener) => {
			listeners.add(listener)
			return () => listeners.delete(listener)
		},
		() => target,
	)
}
