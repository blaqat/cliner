import { useSyncExternalStore } from "react"

/** The panels the view's title bar opens as an overlay (not chat-specific, so not in the composer). */
export type TopBarPanel = "mcp" | "rules"

let openPanel: TopBarPanel | null = null
const listeners = new Set<() => void>()

export function openTopBarPanel(panel: TopBarPanel | null): void {
	if (openPanel === panel) return
	openPanel = panel
	for (const listener of listeners) listener()
}

export function getTopBarPanel(): TopBarPanel | null {
	return openPanel
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener)
	return () => listeners.delete(listener)
}

export function useTopBarPanel(): TopBarPanel | null {
	return useSyncExternalStore(subscribe, getTopBarPanel)
}

/**
 * "Use" on a script in the rules overlay: the composer listens and starts a script draft. An event,
 * because the overlay lives above every view rather than inside the composer.
 */
export const USE_SCRIPT_EVENT = "cline:use-script"

export function requestScriptDraft(name: string): void {
	document.dispatchEvent(new CustomEvent<string>(USE_SCRIPT_EVENT, { detail: name }))
}
