import type { MessageWithMetadata as SdkMessage } from "@cline/llms"
import { formatDisplayUserInput } from "@cline/shared"

/**
 * A user/assistant message in a thread's transcript, numbered by its ordinal
 * in the filtered list — the same `n` appears as `#<n>` in grep output and in
 * read_thread's `start`/`end` parameters, so ranges address exactly what grep
 * reported. System/tool entries are skipped entirely.
 */
export interface TranscriptEntry {
	/** Ordinal in the filtered transcript; `#<index>` in tool output. */
	index: number
	ts: number
	role: string
	text: string
}

/** Plain-text extraction for an SDK message's content blocks. */
export function sdkMessageText(content: unknown): string {
	if (typeof content === "string") {
		return content
	}
	if (!Array.isArray(content)) {
		return ""
	}
	const parts: string[] = []
	for (const part of content) {
		const block = part as { type?: unknown; text?: unknown }
		if (block?.type === "text" && typeof block.text === "string") {
			parts.push(block.text)
		}
	}
	return parts.join("\n")
}

/** Same text extraction for legacy `api_conversation_history.json` entries. */
function legacyContentText(content: unknown): string {
	return sdkMessageText(content)
}

/** SDK messages -> transcript entries, numbered sequentially. */
export function sdkMessagesToTranscript(messages: readonly SdkMessage[]): TranscriptEntry[] {
	const entries: TranscriptEntry[] = []
	for (const message of messages) {
		if (message.role !== "user" && message.role !== "assistant") {
			continue
		}
		const raw = sdkMessageText(message.content)
		const text = message.role === "user" ? formatDisplayUserInput(raw) : raw
		if (!text.trim()) {
			continue
		}
		entries.push({ index: entries.length, ts: message.ts ?? 0, role: message.role, text })
	}
	return entries
}

/** Legacy api conversation history -> transcript entries. */
export function legacyHistoryToTranscript(
	messages: readonly { role?: string; content?: unknown; ts?: number }[],
): TranscriptEntry[] {
	const entries: TranscriptEntry[] = []
	for (const message of messages) {
		if (message.role !== "user" && message.role !== "assistant") {
			continue
		}
		const raw = legacyContentText(message.content)
		const text = message.role === "user" ? formatDisplayUserInput(raw) : raw
		if (!text.trim()) {
			continue
		}
		entries.push({ index: entries.length, ts: message.ts ?? 0, role: message.role, text })
	}
	return entries
}

/** Legacy ui_messages (ClineMessage) -> transcript entries. */
export function clineMessagesToTranscript(
	messages: readonly { ts?: number; type?: string; say?: string; ask?: string; text?: string }[],
): TranscriptEntry[] {
	const entries: TranscriptEntry[] = []
	for (const message of messages) {
		const text = message.text
		if (!text?.trim()) {
			continue
		}
		const isUser =
			(message.type === "say" && (message.say === "task" || message.say === "user_feedback")) || message.type === "ask"
		const isAssistant = message.type === "say" && (message.say === "text" || message.say === "completion_result")
		if (!isUser && !isAssistant) {
			continue
		}
		entries.push({
			index: entries.length,
			ts: message.ts ?? 0,
			role: isUser ? "user" : "assistant",
			text: isUser ? formatDisplayUserInput(text) : text,
		})
	}
	return entries
}

export interface TranscriptGrepHit {
	/** Transcript ordinal — `#<index>` in output and read_thread's range. */
	index: number
	role: string
	/** The single line inside the message's text that matched. */
	line: string
}

export const TRANSCRIPT_GREP_MAX_HITS = 50
export const TRANSCRIPT_READ_MAX_MESSAGES = 100
export const TRANSCRIPT_READ_MAX_CHARS = 40_000

/**
 * Line-level, case-insensitive grep across transcript entries. `pattern` is a
 * JS regex (e.g. `callback|redirect_uri`); lines are returned trimmed.
 */
export function grepTranscript(
	entries: readonly TranscriptEntry[],
	pattern: RegExp,
	maxHits = TRANSCRIPT_GREP_MAX_HITS,
): TranscriptGrepHit[] {
	const hits: TranscriptGrepHit[] = []
	for (const entry of entries) {
		if (hits.length >= maxHits) break
		for (const line of entry.text.split("\n")) {
			if (hits.length >= maxHits) break
			if (pattern.test(line)) {
				hits.push({ index: entry.index, role: entry.role, line: line.trim() })
			}
		}
	}
	return hits
}

/**
 * Inclusive `start`..`end` slice over transcript ordinals, capped in message
 * count so one call can't flood the context. Character limits are applied
 * afterwards by {@link pageTranscriptText}, so an oversized message stays
 * readable in pages instead of being dropped.
 */
export function sliceTranscript(
	entries: readonly TranscriptEntry[],
	start: number,
	end: number,
): { entries: TranscriptEntry[]; truncated: boolean } {
	const lo = Math.max(0, start)
	const hi = Math.min(entries.length - 1, end)
	if (hi < lo || entries.length === 0) {
		return { entries: [], truncated: false }
	}
	const inRange = entries.filter((entry) => entry.index >= lo && entry.index <= hi)
	const slice = inRange.slice(0, TRANSCRIPT_READ_MAX_MESSAGES)
	return { entries: slice, truncated: inRange.length > slice.length }
}

/** The text read_thread pages over: each message as `#<n> <role>: <text>`, blank-line separated. */
export function formatTranscriptEntries(entries: readonly TranscriptEntry[]): string {
	return entries.map((entry) => `#${entry.index} ${entry.role}: ${entry.text}`).join("\n\n")
}

export interface TranscriptTextPage {
	text: string
	/** Character offset of `text` within the full text. */
	offset: number
	/** Total characters in the full text. */
	total: number
	/** Offset to pass to continue, when the page does not reach the end. */
	nextOffset?: number
}

/**
 * Character window over `text`. `offset`/`limit` are in characters (UTF-16
 * code units as JS counts them); a window never splits a surrogate pair.
 */
export function pageTranscriptText(text: string, offset: number, limit: number = TRANSCRIPT_READ_MAX_CHARS): TranscriptTextPage {
	const size = Math.min(Math.max(1, Math.trunc(limit)), TRANSCRIPT_READ_MAX_CHARS)
	const isLowSurrogate = (index: number) => {
		const code = text.charCodeAt(index)
		return code >= 0xdc00 && code <= 0xdfff
	}
	let from = Math.min(Math.max(0, Math.trunc(offset)), text.length)
	if (from > 0 && from < text.length && isLowSurrogate(from)) from -= 1
	let to = Math.min(text.length, from + size)
	if (to < text.length && to > from + 1 && isLowSurrogate(to)) to -= 1
	return { text: text.slice(from, to), offset: from, total: text.length, ...(to < text.length ? { nextOffset: to } : {}) }
}
