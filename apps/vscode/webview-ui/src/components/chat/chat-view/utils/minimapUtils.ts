import type { ClineMessage, ClinePlanModeResponse } from "@shared/ExtensionMessage"

export interface MinimapItem {
	/** Index into the rendered (grouped) list to jump to, for scrollToIndex. */
	index: number
	/** First row index the square covers; the square is "current" from here on. */
	startIndex: number
	ts: number
	role: "user" | "agent"
	snippet: string
	/** The reply is still streaming. */
	streaming: boolean
}

const SNIPPET_LENGTH = 140

function toSnippet(text: string): string {
	const flat = text.replace(/\s+/g, " ").trim()
	return flat.length > SNIPPET_LENGTH ? `${flat.slice(0, SNIPPET_LENGTH - 1)}…` : flat
}

function agentText(message: ClineMessage): string | undefined {
	if (message.type === "say" && (message.say === "text" || message.say === "completion_result")) {
		return message.text
	}
	if (message.type === "say" && message.say === "plan_completion_result") {
		return message.text
	}
	if (message.type === "ask" && (message.ask === "plan_mode_respond" || message.ask === "followup")) {
		try {
			const parsed = JSON.parse(message.text || "{}") as ClinePlanModeResponse & { question?: string }
			return parsed.response ?? parsed.question ?? message.text
		} catch {
			return message.text
		}
	}
	return undefined
}

function isUserMessage(message: ClineMessage): boolean {
	return message.type === "say" && message.say === "user_feedback"
}

function userSnippet(message: ClineMessage): string {
	const text = message.text?.trim() || (message.images?.length || message.files?.length ? "(attachments)" : "")
	return toSnippet(text)
}

/** Maps every rendered message (including members of grouped rows) to its row index. */
function indexRows(rows: readonly (ClineMessage | ClineMessage[])[]): Map<number, number> {
	const rowByTs = new Map<number, number>()
	rows.forEach((row, index) => {
		for (const message of Array.isArray(row) ? row : [row]) {
			rowByTs.set(message.ts, index)
		}
	})
	return rowByTs
}

/**
 * One minimap square per user message, each followed by one square for the agent's reply
 * to that turn. The task prompt (rendered in the header, not the list) is the first user
 * square. Everything the agent produced between two user messages (tool groups, reasoning,
 * partial text) collapses into the reply square, which jumps to the turn's last rendered
 * row and previews its latest agent text.
 *
 * Turns come from the unfiltered transcript (`messages`), since the rendered `rows` hide
 * some user messages (e.g. the echo of a selected followup option); jump targets are then
 * mapped onto the rendered rows.
 */
export function getMinimapItems(
	messages: readonly ClineMessage[],
	rows: readonly (ClineMessage | ClineMessage[])[],
	task?: ClineMessage,
	/**
	 * The backend reports an active turn. When given, it decides whether the last reply is
	 * streaming: `partial` flips off and on between every message of a turn, which would
	 * restart the square's animation each time.
	 */
	turnActive?: boolean,
): MinimapItem[] {
	const items: MinimapItem[] = []
	if (task) {
		items.push({ index: 0, startIndex: -1, ts: task.ts, role: "user", snippet: userSnippet(task), streaming: false })
	}

	const rowByTs = indexRows(rows)
	// Nearest rendered row at or after message `from`.
	const nextRenderedRow = (from: number): number | undefined => {
		for (let i = from; i < messages.length; i++) {
			const row = rowByTs.get(messages[i].ts)
			if (row !== undefined) {
				return row
			}
		}
		return undefined
	}

	let turnStart = -1
	let lastIndex = -1
	let lastMessage: ClineMessage | undefined
	let lastText: string | undefined
	const flushTurn = (isLastTurn: boolean) => {
		if (lastIndex >= 0 && lastMessage) {
			// Only the last turn can be in progress.
			const streaming = turnActive === undefined ? lastMessage.partial === true : isLastTurn && turnActive
			items.push({
				index: lastIndex,
				startIndex: turnStart,
				ts: lastMessage.ts,
				role: "agent",
				snippet: lastText ?? (streaming ? "Working…" : "Used tools"),
				streaming,
			})
		}
		turnStart = -1
		lastIndex = -1
		lastMessage = undefined
		lastText = undefined
	}

	messages.forEach((message, messageIndex) => {
		const row = rowByTs.get(message.ts)
		if (isUserMessage(message)) {
			flushTurn(false)
			// A hidden user message (the echo of a selected followup option) jumps to the
			// question row that shows the selection, else to the next rendered row.
			const previous = messages[messageIndex - 1]
			const optionRow = previous?.type === "ask" ? rowByTs.get(previous.ts) : undefined
			const index = row ?? optionRow ?? nextRenderedRow(messageIndex + 1)
			if (index !== undefined) {
				items.push({
					index,
					startIndex: index,
					ts: message.ts,
					role: "user",
					snippet: userSnippet(message),
					streaming: false,
				})
			}
			return
		}
		const text = agentText(message)?.trim()
		if (text) {
			lastText = toSnippet(text)
		}
		if (row === undefined) {
			return
		}
		if (turnStart < 0) {
			turnStart = row
		}
		// Keep the containing row of the latest rendered message, even when it's a grouped row.
		lastIndex = row
		lastMessage = message
	})
	flushTurn(true)
	return items
}

/** Stable identity of a square: unlike `ts`, it doesn't change as the turn it covers grows. */
export function minimapItemKey(item: MinimapItem): string {
	return `${item.role}:${item.startIndex}`
}

/**
 * The item covering the row at the top of the viewport: the last item starting at or before
 * `topIndex`. Pass `Number.MAX_SAFE_INTEGER` while the list follows new output: the reader is
 * at the live end, so the last turn stays current however the rows above shift as it grows.
 */
export function getCurrentMinimapItem(items: readonly MinimapItem[], topIndex: number): MinimapItem | undefined {
	let current: MinimapItem | undefined
	for (const item of items) {
		if (item.startIndex > topIndex) {
			break
		}
		current = item
	}
	return current ?? items[0]
}
