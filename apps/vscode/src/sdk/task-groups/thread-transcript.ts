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
 * count and characters so one call can't flood the context.
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
	let truncated = inRange.length > slice.length
	let chars = 0
	const kept: TranscriptEntry[] = []
	for (const entry of slice) {
		chars += entry.text.length
		if (chars > TRANSCRIPT_READ_MAX_CHARS) {
			truncated = true
			break
		}
		kept.push(entry)
	}
	return { entries: kept, truncated }
}
