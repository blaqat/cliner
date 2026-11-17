import type { ClineMessage } from "@shared/ExtensionMessage"
import type { MessageLinkAnchor } from "@shared/message-links"
import { sdkMessagesToClineMessages } from "./message-translator"
import { findSdkMessageAnchor } from "./sdk-aside-conversation"
import { sanitizeSdkUserMessagesForDisplay } from "./sdk-task-history"
import type { SdkInitialMessages } from "./session-host"

/** Rendered rows whose text a message link can quote (tool rows are anchored by call id instead). */
const TEXT_ROW_KINDS = new Set([
	"task",
	"user_feedback",
	"text",
	"completion_result",
	"plan_completion_result",
	"plan_mode_respond",
])
const ASK_TOOL_NAMES = new Set(["ask_question", "ask_followup_question"])
const USER_ROW_KINDS = new Set(["task", "user_feedback"])

function isTextRow(message: ClineMessage): boolean {
	return !message.sdkToolCallId && TEXT_ROW_KINDS.has(message.say ?? message.ask ?? "") && !!message.text
}

interface RawAskToolUse {
	messageIndex: number
	toolCallId: string
	question: string
}

/**
 * The transcript's follow-up question tool calls. Follow-up asks are rendered
 * by the interaction coordinator, not the persisted projection, so their rows
 * are anchored straight to the tool call in the raw transcript.
 */
function listAskToolUses(messages: SdkInitialMessages): RawAskToolUse[] {
	const found: RawAskToolUse[] = []
	messages.forEach((message, messageIndex) => {
		if (message.role !== "assistant" || !Array.isArray(message.content)) return
		for (const block of message.content) {
			if (block.type !== "tool_use" || !ASK_TOOL_NAMES.has(block.name)) continue
			const question = (block.input as { question?: unknown } | undefined)?.question
			if (typeof question === "string") found.push({ messageIndex, toolCallId: block.id, question })
		}
	})
	return found
}

function followupQuestion(row: ClineMessage): string | undefined {
	if (row.ask !== "followup" || !row.text) return undefined
	try {
		const parsed = JSON.parse(row.text) as { question?: unknown }
		return typeof parsed.question === "string" ? parsed.question : undefined
	} catch {
		return row.text
	}
}

function project(messages: SdkInitialMessages, cwd?: string): ClineMessage[] {
	return sdkMessagesToClineMessages(sanitizeSdkUserMessagesForDisplay(messages), undefined, { cwd })
}

/**
 * The link target for a rendered row: its transcript message plus an anchor
 * telling which row of that message it is. Rows are identified through the
 * same projection that renders history, so the link resolves to exactly the
 * row's own text.
 */
export function findMessageLinkTarget(
	messages: SdkInitialMessages,
	visibleMessages: ClineMessage[],
	messageTs: number,
	cwd?: string,
): { messageIndex?: number; anchor: MessageLinkAnchor } {
	const { sourceIndex, toolCallId, targetIndex } = findSdkMessageAnchor(messages, visibleMessages, messageTs, cwd)
	if (sourceIndex === undefined) {
		const target = visibleMessages[targetIndex]
		const question = target ? followupQuestion(target) : undefined
		if (question === undefined) return { anchor: {} }
		// Identical questions are told apart by their order among the visible follow-ups.
		const occurrence = visibleMessages.slice(0, targetIndex).filter((row) => followupQuestion(row) === question).length
		const match = listAskToolUses(messages).filter((use) => use.question === question)[occurrence]
		return match ? { messageIndex: match.messageIndex, anchor: { toolCallId: match.toolCallId } } : { anchor: {} }
	}
	// Completion-tool rows (and any other tool-derived row) are addressed by their call id.
	if (toolCallId) return { messageIndex: sourceIndex, anchor: { toolCallId } }
	const target = visibleMessages[targetIndex]
	const siblings = project(messages, cwd).filter((row) => row.sdkMessageIndex === sourceIndex && isTextRow(row))
	if (siblings.length < 2 || !target?.text) return { messageIndex: sourceIndex, anchor: {} }
	const sameKind = (row: ClineMessage) => (row.say ?? row.ask) === (target.say ?? target.ask)
	const sameText = (row: ClineMessage) => row.text === target.text
	// Identical sibling texts are told apart by their order among the visible rows.
	const occurrence = visibleMessages
		.slice(0, targetIndex)
		.filter(
			(row) => !row.sdkToolCallId && sameText(row) && sameKind(row) && (row.sdkMessageIndex ?? sourceIndex) === sourceIndex,
		).length
	const matches = siblings.filter((row) => sameText(row) && sameKind(row))
	const chosen = matches[occurrence] ?? siblings.find(sameText)
	const block = chosen ? siblings.indexOf(chosen) : -1
	return { messageIndex: sourceIndex, anchor: block >= 0 ? { block } : {} }
}

/**
 * The text a message link points at, taken from the rendered rows of the
 * message: the row of the anchored tool call, the anchored text row, or - for
 * links without an anchor - every text row of the message together.
 */
export function resolveLinkedMessageText(
	messages: SdkInitialMessages,
	messageIndex: number,
	anchor: MessageLinkAnchor,
	cwd?: string,
): { role: "user" | "assistant"; text: string } | undefined {
	const projected = project(messages, cwd)
	const toRole = (row: ClineMessage) => (USER_ROW_KINDS.has(row.say ?? "") ? "user" : "assistant")
	if (anchor.toolCallId) {
		const rows = projected.filter((row) => row.sdkToolCallId === anchor.toolCallId && !!row.text)
		const row = rows.find((candidate) => candidate.say === "completion_result") ?? rows[0]
		if (row) return { role: toRole(row), text: row.text ?? "" }
		const ask = listAskToolUses(messages).find((use) => use.toolCallId === anchor.toolCallId)
		return ask ? { role: "assistant", text: ask.question } : undefined
	}
	const inMessage = projected.filter((row) => row.sdkMessageIndex === messageIndex)
	const textRows = inMessage.filter(isTextRow)
	if (anchor.block !== undefined) {
		const row = textRows[anchor.block]
		return row ? { role: toRole(row), text: row.text ?? "" } : undefined
	}
	// Links minted before anchors: the message's text rows, plus a completion-tool row that
	// shares the message (those links used to point at the tool-result message).
	const rows = [...textRows, ...inMessage.filter((row) => row.say === "completion_result" && !!row.text && row.sdkToolCallId)]
	if (rows.length === 0) return undefined
	return { role: toRole(rows[0]), text: rows.map((row) => row.text).join("\n\n") }
}
