/**
 * The `<message_reference>` block a message tag becomes when it is sent: the
 * source thread, who wrote the message and its text. The host prepends these to
 * the user's text, so they are persisted in the user message and must be parsed
 * back out wherever that text is displayed (bubbles, titles, previews).
 */
export interface MessageReferenceInfo {
	threadId: string
	threadTitle: string
	/** "user" or "assistant". */
	author: "user" | "assistant"
	text: string
}

/** Longest message text injected per tag; a single pasted message should never flood the context. */
const MAX_MESSAGE_CHARS = 20_000
const TAG = "message_reference"
const OPEN = `<${TAG} `
const CLOSE = `</${TAG}>`
// The body is not escaped, so a literal closing tag inside it is neutralised and restored on parse.
const ESCAPED_CLOSE = `<\\/${TAG}>`

function escapeAttr(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

function unescapeAttr(value: string): string {
	return value
		.replace(/&gt;/g, ">")
		.replace(/&lt;/g, "<")
		.replace(/&quot;/g, '"')
		.replace(/&amp;/g, "&")
}

/**
 * The context block for one message tag. Unlike a `thread:` mention this
 * carries the one message only and says nothing about transcript access.
 */
export function formatMessageReference(reference: MessageReferenceInfo): string {
	const author = reference.author === "user" ? "user" : "assistant"
	const body =
		reference.text.length > MAX_MESSAGE_CHARS
			? `${reference.text.slice(0, MAX_MESSAGE_CHARS)}\n[message truncated]`
			: reference.text
	return `${OPEN}thread_id="${escapeAttr(reference.threadId)}" thread_title="${escapeAttr(reference.threadTitle)}" author="${author}">\n${body.split(CLOSE).join(ESCAPED_CLOSE)}\n${CLOSE}`
}

/** Prepends the blocks to the user's text (the way quote chips are), separated by blank lines. */
export function prependMessageReferences(text: string, blocks: readonly string[]): string {
	if (blocks.length === 0) return text
	return [...blocks, text].filter((part) => part.length > 0).join("\n\n")
}

function readAttributes(openTag: string): Record<string, string> {
	const attributes: Record<string, string> = {}
	for (const match of openTag.matchAll(/([a-z_]+)="([^"]*)"/g)) {
		attributes[match[1]] = unescapeAttr(match[2])
	}
	return attributes
}

/**
 * Splits the references out of displayed user text. indexOf-based rather than
 * one lazy regex so a stray opening tag can't make the scan polynomial.
 */
export function parseMessageReferences(input: string): { text: string; references: MessageReferenceInfo[] } {
	if (!input.includes(OPEN)) return { text: input, references: [] }
	const references: MessageReferenceInfo[] = []
	let remaining = ""
	let cursor = 0
	for (;;) {
		const start = input.indexOf(OPEN, cursor)
		if (start === -1) break
		const openEnd = input.indexOf(">", start)
		const close = openEnd === -1 ? -1 : input.indexOf(CLOSE, openEnd)
		if (close === -1) break
		const attributes = readAttributes(input.slice(start, openEnd))
		references.push({
			threadId: attributes.thread_id ?? "",
			threadTitle: attributes.thread_title ?? "",
			author: attributes.author === "user" ? "user" : "assistant",
			text: input
				.slice(openEnd + 1, close)
				.replace(/^\n/, "")
				.replace(/\n$/, "")
				.split(ESCAPED_CLOSE)
				.join(CLOSE),
		})
		remaining += input.slice(cursor, start)
		cursor = close + CLOSE.length
	}
	remaining += input.slice(cursor)
	// Blocks sit ahead of the typed text, separated by blank lines.
	return { text: references.length > 0 ? remaining.trim() : input, references }
}

/** The text without its message-reference blocks (titles, previews, search snippets). */
export function stripMessageReferences(input: string): string {
	return parseMessageReferences(input).text
}

/** The chip label for a reference: "You · Dev plan" / "Cline · Dev plan". */
export function messageReferenceSource(reference: Pick<MessageReferenceInfo, "author" | "threadTitle">): string {
	const who = reference.author === "user" ? "You" : "Cline"
	return reference.threadTitle ? `${who} · ${reference.threadTitle}` : who
}
