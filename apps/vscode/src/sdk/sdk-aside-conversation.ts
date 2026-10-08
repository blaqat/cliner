import type { ClineMessage } from "@shared/ExtensionMessage"
import { sanitizeInitialMessagesForSessionStart } from "./initial-message-sanitizer"
import { sdkMessagesToClineMessages } from "./message-translator"
import { sanitizeSdkUserMessagesForDisplay } from "./sdk-task-history"
import type { SdkInitialMessages } from "./session-host"

/** Copies the native transcript, preserving tool pairs and attachment blocks. */
export function buildAsideConversation(
	messages: SdkInitialMessages,
	visibleMessages: ClineMessage[],
	messageTs: number,
	cwd?: string,
): SdkInitialMessages {
	const targetIndex = visibleMessages.findIndex((message) => message.ts === messageTs)
	if (targetIndex < 0) throw new Error("Aside message not found")
	const target = visibleMessages[targetIndex]
	let sourceIndex = target.sdkMessageIndex
	let toolCallId = target.sdkToolCallId
	if (sourceIndex === undefined) {
		// Live rows have process-local ids. Match their occurrence in the persisted projection.
		const matches = (message: ClineMessage) =>
			(message.text === target.text || (target.partial && !!target.text && message.text?.startsWith(target.text))) &&
			((message.say ?? message.ask) === (target.say ?? target.ask) ||
				["text", "completion_result", "plan_completion_result", "plan_mode_respond"].includes(
					message.say ?? message.ask ?? "",
				))
		const ordinal = visibleMessages.slice(0, targetIndex + 1).filter(matches).length - 1
		const projected = sdkMessagesToClineMessages(sanitizeSdkUserMessagesForDisplay(messages), undefined, { cwd })
		const projectedTarget = projected.filter(matches)[Math.max(0, ordinal)]
		sourceIndex = projectedTarget?.sdkMessageIndex
		toolCallId = projectedTarget?.sdkToolCallId
	}
	if (sourceIndex === undefined && !target.text) {
		const previous = visibleMessages
			.slice(0, targetIndex)
			.reverse()
			.find((message) => !!message.text)
		if (previous) return buildAsideConversation(messages, visibleMessages, previous.ts, cwd)
	}
	if (sourceIndex === undefined && target.partial && target.text) {
		const previous = visibleMessages
			.slice(0, targetIndex)
			.reverse()
			.find((message) => !!message.text && !message.partial)
		const prefix = previous ? buildAsideConversation(messages, visibleMessages, previous.ts, cwd) : []
		return sanitizeInitialMessagesForSessionStart([...prefix, { role: "assistant", content: target.text }])
	}
	if (sourceIndex === undefined || sourceIndex >= messages.length)
		throw new Error("Aside message has no SDK transcript position")
	const copied = structuredClone(messages.slice(0, sourceIndex + 1))
	// An assistant message can contain several rendered blocks. Cut after the selected block.
	if (toolCallId) {
		for (const message of copied) {
			if (!Array.isArray(message.content)) continue
			const index = message.content.findIndex(
				(block) =>
					(block.type === "tool_use" && block.id === toolCallId) ||
					(block.type === "tool_result" && block.tool_use_id === toolCallId),
			)
			if (index >= 0) message.content = message.content.slice(0, index + 1)
		}
	}
	const last = copied.at(-1)
	if (last?.role === "assistant" && Array.isArray(last.content) && target.text) {
		const blockIndex = last.content.findIndex(
			(block) =>
				(block.type === "text" &&
					(block.text.trim() === target.text?.trim() ||
						(target.partial && block.text.startsWith(target.text ?? "")))) ||
				(block.type === "thinking" && block.thinking.trim() === target.text?.trim()),
		)
		if (blockIndex >= 0) {
			last.content = last.content.slice(0, blockIndex + 1)
			const block = last.content[blockIndex]
			if (target.partial && block.type === "text") block.text = target.text
		}
	}
	return sanitizeInitialMessagesForSessionStart(copied)
}
