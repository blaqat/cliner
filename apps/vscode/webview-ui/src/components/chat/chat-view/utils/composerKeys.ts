import type { ExtensionState } from "@shared/ExtensionMessage"

export type EnterSendsAs = ExtensionState["enterSendsAs"]

/** How a composer submit is delivered. "send" is the normal path when the agent is idle. */
export type SendKind = "send" | "steer" | "interject" | "aside" | "background"

export interface SubmitKeyEvent {
	key: string
	shiftKey: boolean
	altKey: boolean
	ctrlKey: boolean
	metaKey: boolean
}

export function otherSendKind(kind: EnterSendsAs): EnterSendsAs {
	return kind === "steer" ? "interject" : "steer"
}

/**
 * Maps a composer keystroke to a send kind, or null when it is not a submit.
 * Alt+Enter always sends as an aside. While the focused task runs, Enter
 * follows `enterSendsAs` and Ctrl/Cmd+Enter does the other one. On the home
 * screen (no task), Ctrl/Cmd+Enter starts the draft as a background chat.
 */
export function resolveSubmitKey(
	event: SubmitKeyEvent,
	{ running, enterSendsAs, onHome }: { running: boolean; enterSendsAs: EnterSendsAs; onHome?: boolean },
): SendKind | null {
	if (event.key !== "Enter" || event.shiftKey) {
		return null
	}
	if (event.altKey) {
		return "aside"
	}
	if (!running) {
		return onHome && (event.ctrlKey || event.metaKey) ? "background" : "send"
	}
	return event.ctrlKey || event.metaKey ? otherSendKind(enterSendsAs) : enterSendsAs
}
