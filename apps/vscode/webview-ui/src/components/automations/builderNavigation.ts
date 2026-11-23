import { useSyncExternalStore } from "react"

/** What the builder page shows: a saved file, a blank automation, the describe-it box, or a task's draft. */
export interface AutomationBuilderTarget {
	path?: string
	describe?: boolean
	changeWithPrompt?: boolean
	/** A task whose threads become the draft ("Save as an automation"). */
	fromTask?: string
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

/** "Save as an automation" on a task page: leaves the page and opens the builder with a draft of the task. */
export function saveTaskAsAutomation(taskGroupId: string, leaveTaskPage: () => void): void {
	leaveTaskPage()
	// After the page closes: opening a task page closes the builder.
	setTimeout(() => openAutomationBuilder({ fromTask: taskGroupId }), 0)
}
