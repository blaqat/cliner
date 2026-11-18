import type { ClineMessage } from "@shared/ExtensionMessage"

export interface SideThreadNote {
	message: ClineMessage
	pending: boolean
}

export function sideThreadNotes(value: unknown): SideThreadNote[] {
	if (!Array.isArray(value)) return []
	return value.filter(
		(note): note is SideThreadNote =>
			!!note &&
			typeof note.pending === "boolean" &&
			note.message?.say === "subagent_update" &&
			typeof note.message.text === "string" &&
			note.message.text.startsWith("<side_thread_update "),
	)
}

export function mergeSideThreadNotes(messages: ClineMessage[], value: unknown, nextTs: () => number): ClineMessage[] {
	const notes = sideThreadNotes(value)
	if (!notes.length) return messages
	const result = [...messages]
	for (const { message } of notes) {
		const anchor = message.sdkMessageIndex
		const next =
			anchor === undefined
				? -1
				: result.findIndex((row) => row.sdkMessageIndex !== undefined && row.sdkMessageIndex > anchor)
		result.splice(next < 0 ? result.length : next, 0, { ...message, seq: undefined, epoch: undefined })
	}
	return result.map((message) => ({ ...message, ts: nextTs() }))
}

export function sideThreadNoteText(sideId: string, text: string): string {
	const safeId = sideId.replace(/[&<>"']/g, "_")
	// Keep model-provided text from forging another update in the transcript row.
	return `<side_thread_update thread="${safeId}">\n${text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}\n</side_thread_update>`
}
