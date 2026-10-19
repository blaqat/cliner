export interface MessageReference {
	threadId: string
	threadTitle: string
	/** "user" or "assistant", as resolved from the linked message. */
	author: string
	text: string
}

/** Longest message text injected per tag; a single pasted message should never flood the context. */
const MAX_MESSAGE_CHARS = 20_000

function escapeAttr(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

/**
 * The context block for one message tag: the source thread (id + title), who
 * wrote the message and its text. Unlike a `thread:` mention this carries the
 * one message only and says nothing about transcript access.
 */
export function formatMessageReference(reference: MessageReference): string {
	const author = reference.author === "user" ? "user" : "assistant"
	const text =
		reference.text.length > MAX_MESSAGE_CHARS
			? `${reference.text.slice(0, MAX_MESSAGE_CHARS)}\n[message truncated]`
			: reference.text
	return `<message_reference thread_id="${escapeAttr(reference.threadId)}" thread_title="${escapeAttr(reference.threadTitle)}" author="${author}">\n${text}\n</message_reference>`
}

/** Prepends the blocks to the user's text (the way quote chips are), separated by blank lines. */
export function prependMessageReferences(text: string, blocks: readonly string[]): string {
	if (blocks.length === 0) return text
	return [...blocks, text].filter((part) => part.length > 0).join("\n\n")
}
