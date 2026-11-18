import type { ClineMessage } from "./ExtensionMessage"

/**
 * Side threads: "Side thread" (/side, kept) and "Side question" (/btw, a quick
 * card that closes itself). Internally both are asides (parentTaskId set, not a
 * subagent). Shared by the host and the webview, so no Node or DOM imports.
 */
export type SideThreadKind = "side" | "btw"

const TITLE_MAX = 60

/** A side thread's default title: its first message (or the message it came from), trimmed. No model call. */
export function sideThreadTitle(text: string | undefined, fallback = "Side thread"): string {
	const line = (text ?? "")
		.split("\n")
		.map((part) => part.replace(/\s+/g, " ").trim())
		.find(Boolean)
	if (!line) return fallback
	return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1).trimEnd()}…` : line
}

/** Sent to the side thread by Wrap up. Its answer becomes the draft note the user approves. */
export const WRAP_UP_PROMPT =
	"Wrap up: write a short note for the main thread with what it should know from this side thread. Reply with only the note."

/**
 * The side thread's own rows, without the copy of Main it started from. Rows
 * read from the transcript carry `sdkMessageIndex`; live rows don't, and come
 * after the last copied row.
 */
export function sideThreadOwnMessages(messages: readonly ClineMessage[], forkIndex: number | undefined): ClineMessage[] {
	if (!forkIndex) return [...messages]
	let lastCopied = -1
	messages.forEach((message, index) => {
		if (message.sdkMessageIndex !== undefined && message.sdkMessageIndex < forkIndex) lastCopied = index
	})
	return messages
		.slice(lastCopied + 1)
		.filter((message) => message.sdkMessageIndex === undefined || message.sdkMessageIndex >= forkIndex)
}

/** The side thread's latest answer: the last finished or streaming assistant text. */
export function sideThreadAnswer(messages: readonly ClineMessage[]): ClineMessage | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index]
		if (message.type === "say" && (message.say === "user_feedback" || message.say === "task")) return undefined
		const answer =
			(message.type === "say" &&
				(message.say === "text" || message.say === "completion_result" || message.say === "plan_completion_result")) ||
			(message.type === "ask" && (message.ask === "plan_mode_respond" || message.ask === "followup"))
		if (answer && message.text?.trim()) return message
	}
	return undefined
}

/** Text of an answer row; followup and plan rows carry JSON with the reply in `response`/`question`. */
export function sideThreadAnswerText(message: ClineMessage | undefined): string {
	if (!message?.text) return ""
	if (message.type === "ask") {
		try {
			const parsed = JSON.parse(message.text) as { response?: string; question?: string }
			return (parsed.response ?? parsed.question ?? message.text).trim()
		} catch {
			return message.text.trim()
		}
	}
	return message.text.trim()
}
