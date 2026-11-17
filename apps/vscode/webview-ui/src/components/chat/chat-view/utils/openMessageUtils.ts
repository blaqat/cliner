import type { ClineMessage } from "@shared/ExtensionMessage"

export interface OpenMessageTarget {
	messageIndex: number
	text: string
	toolCallId?: string
	block?: number
}

// Mirrors the host's text-row definition (src/sdk/message-link-anchor.ts), so a
// link's `block` ordinal counts the same rows on both sides.
const TEXT_ROW_KINDS = new Set(["task", "user_feedback", "text", "completion_result", "plan_mode_respond"])
const isTextRow = (message: ClineMessage) =>
	!message.sdkToolCallId && TEXT_ROW_KINDS.has(message.say ?? message.ask ?? "") && !!message.text

/**
 * Finds the row a message deep link points at. A tool-call anchor wins (the
 * completion-tool row); otherwise the `block` ordinal picks among the
 * message's text rows, with the resolved text as the tie-breaker. Links
 * without an anchor open the message's first row.
 */
export function findOpenMessageIndex(messages: readonly ClineMessage[], target: OpenMessageTarget): number {
	if (target.toolCallId) {
		const byTool = messages.findIndex(
			(m) => m.sdkToolCallId === target.toolCallId && (!target.text || m.text === target.text),
		)
		if (byTool >= 0) return byTool
		const anyTool = messages.findIndex((m) => m.sdkToolCallId === target.toolCallId)
		if (anyTool >= 0) return anyTool
	}
	if (target.block !== undefined) {
		const rows = messages.flatMap((m, index) => (m.sdkMessageIndex === target.messageIndex && isTextRow(m) ? [index] : []))
		const byBlock = rows[target.block]
		if (byBlock !== undefined && (!target.text || messages[byBlock].text === target.text)) return byBlock
		const byText = rows.find((index) => messages[index].text === target.text)
		if (byText !== undefined) return byText
		if (byBlock !== undefined) return byBlock
	}
	const first = messages.findIndex((m) => m.sdkMessageIndex === target.messageIndex)
	if (first >= 0) return first
	return target.text ? messages.findIndex((m) => m.text === target.text) : -1
}
