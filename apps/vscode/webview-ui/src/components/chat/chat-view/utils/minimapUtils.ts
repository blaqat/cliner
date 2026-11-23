import type { ClineMessage, ClinePlanModeResponse } from "@shared/ExtensionMessage"

/**
 * What the block that ended a turn's reply is: a completed task, an Ask-mode answer, a followup
 * question, or plain agent output. The preview names it; it doesn't color the strip.
 */
export type MinimapKind = "agent" | "completion" | "answer" | "question"

/** A turn that ends waiting on the user, or on an error: its strip takes that color. */
export type MinimapAttention = "approval" | "question" | "error"

/** One strip of the minimap: a turn, from the user's prompt to the end of the agent's reply. */
export interface MinimapTurn {
	/** Row the strip jumps to (the prompt's row), for scrollToIndex. */
	index: number
	/** First row the turn covers; the turn is "current" from here on. */
	startIndex: number
	/** Last rendered row of the turn: the reply's last row, or the prompt's while there's no reply. */
	endIndex: number
	/** The prompt's timestamp. */
	ts: number
	/** The prompt, flattened ("" for agent output before any prompt). */
	prompt: string
	/** The reply's latest text, flattened. */
	reply?: string
	/** The block the reply's latest text came from. */
	replyKind: MinimapKind
	/** Tool calls, commands, browser and MCP calls in the reply. */
	tools: number
	/** Errors the reply ran into (it may have recovered). */
	errors: number
	/** The turn ended waiting on the user, or on an error it didn't recover from. */
	attention?: MinimapAttention
	/** The reply is still streaming. */
	streaming: boolean
}

const SNIPPET_LENGTH = 280

/** Fewer turns than this and the thread fits on screen: no minimap (T3 Code's rule). */
export const MINIMAP_MIN_TURNS = 2

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

/** The block kind an agent message renders as (see ChatRow). */
export function getMinimapKind(message: ClineMessage): MinimapKind {
	if (message.type === "say") {
		if (message.say === "completion_result") {
			return "completion"
		}
		if (message.say === "plan_completion_result") {
			return "answer"
		}
		return "agent"
	}
	switch (message.ask) {
		case "completion_result":
			return "completion"
		case "plan_mode_respond":
			return "answer"
		case "followup":
			return "question"
		default:
			return "agent"
	}
}

const TOOL_TYPES = new Set(["tool", "command", "browser_action_launch", "use_mcp_server", "use_subagents"])
const ERROR_SAYS = new Set(["error", "diff_error", "clineignore_error", "command_permission_denied"])
const ERROR_ASKS = new Set(["api_req_failed", "mistake_limit_reached"])
/** Asks that wait for the user to approve a tool, command, browser, MCP call or subagents. */
const APPROVAL_ASKS = new Set(["tool", "command", "browser_action_launch", "use_mcp_server", "use_subagents"])

function isToolCall(message: ClineMessage): boolean {
	return TOOL_TYPES.has((message.type === "say" ? message.say : message.ask) ?? "")
}

function isError(message: ClineMessage): boolean {
	return message.type === "say" ? ERROR_SAYS.has(message.say ?? "") : ERROR_ASKS.has(message.ask ?? "")
}

function isUserMessage(message: ClineMessage): boolean {
	return message.type === "say" && message.say === "user_feedback"
}

/** Messages that don't change what the turn ended on (progress, bookkeeping). */
function isBookkeeping(message: ClineMessage): boolean {
	return (
		message.type === "say" &&
		["api_req_started", "api_req_finished", "checkpoint_created", "reasoning", "info", "deleted_api_reqs"].includes(
			message.say ?? "",
		)
	)
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
 * One minimap turn per user prompt, like T3 Code's timeline minimap. The task prompt (the
 * list's first row, kept out of `messages`) is the first turn. Everything the agent produced
 * until the next prompt (text, tool groups, approvals, errors) belongs to the turn: the preview
 * shows its latest text and counts its tools and errors, and a turn that ended waiting on the
 * user or on an error is flagged.
 *
 * Turns come from the unfiltered transcript (`messages`), since the rendered `rows` hide some
 * user messages (e.g. the echo of a selected followup option); jump targets are then mapped
 * onto the rendered rows.
 */
export function getMinimapTurns(
	messages: readonly ClineMessage[],
	rows: readonly (ClineMessage | ClineMessage[])[],
	task?: ClineMessage,
	/**
	 * The backend reports an active turn. When given, it decides whether the last reply is
	 * streaming: `partial` flips off and on between every message of a turn.
	 */
	turnActive?: boolean,
): MinimapTurn[] {
	const turns: MinimapTurn[] = []
	const rowByTs = indexRows(rows)
	let turn: MinimapTurn | undefined
	// What the turn's reply ended on, to flag a turn left waiting or failed.
	let last: ClineMessage | undefined
	const start = (index: number, ts: number, prompt: string) => {
		turn = {
			index,
			startIndex: index,
			endIndex: index,
			ts,
			prompt,
			replyKind: "agent",
			tools: 0,
			errors: 0,
			streaming: false,
		}
		last = undefined
		turns.push(turn)
	}
	if (task) {
		start(rowByTs.get(task.ts) ?? 0, task.ts, userSnippet(task))
	}

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

	messages.forEach((message, messageIndex) => {
		const row = rowByTs.get(message.ts)
		if (isUserMessage(message)) {
			// A hidden user message (the echo of a selected followup option) jumps to the
			// question row that shows the selection, else to the next rendered row.
			const previous = messages[messageIndex - 1]
			const optionRow = previous?.type === "ask" ? rowByTs.get(previous.ts) : undefined
			const index = row ?? optionRow ?? nextRenderedRow(messageIndex + 1)
			if (index !== undefined) {
				start(index, message.ts, userSnippet(message))
			}
			return
		}
		if (!turn) {
			// Agent output before any prompt (no task row): a turn without a prompt.
			if (row === undefined) {
				return
			}
			start(row, message.ts, "")
		}
		const current = turn as MinimapTurn
		const text = agentText(message)?.trim()
		if (text) {
			current.reply = toSnippet(text)
			current.replyKind = getMinimapKind(message)
		}
		if (!message.partial && isToolCall(message)) {
			current.tools++
		}
		if (isError(message)) {
			current.errors++
		}
		if (!isBookkeeping(message)) {
			last = message
		}
		if (row !== undefined && row > current.endIndex) {
			current.endIndex = row
		}
	})

	const final = turns.at(-1)
	if (final) {
		const hasReply = final.endIndex > final.startIndex || !!final.reply || final.tools > 0
		final.streaming = turnActive === undefined ? last?.partial === true : turnActive && hasReply
	}
	// Only the last turn can still be waiting on the user.
	if (final && last && !final.streaming && !last.partial) {
		if (last.type === "ask" && APPROVAL_ASKS.has(last.ask ?? "")) {
			final.attention = "approval"
		} else if (last.type === "ask" && last.ask === "followup") {
			final.attention = "question"
		}
	}
	// A turn that ended on an error (rather than recovering) is flagged wherever it is.
	for (const [i, item] of turns.entries()) {
		if (item.errors === 0 || item.attention) {
			continue
		}
		const endedOn = i === turns.length - 1 ? last : undefined
		if (endedOn ? isError(endedOn) : endsOnError(messages, rowByTs, item)) {
			item.attention = "error"
		}
	}
	return turns
}

/** Whether the last non-bookkeeping message rendered in a finished turn's rows is an error. */
function endsOnError(messages: readonly ClineMessage[], rowByTs: Map<number, number>, turn: MinimapTurn): boolean {
	let ended: ClineMessage | undefined
	for (const message of messages) {
		const row = rowByTs.get(message.ts)
		if (row === undefined || row < turn.startIndex || row > turn.endIndex) {
			continue
		}
		if (!isUserMessage(message) && !isBookkeeping(message)) {
			ended = message
		}
	}
	return !!ended && isError(ended)
}

/** Stable identity of a strip: unlike `ts` of the reply, it doesn't change as the turn grows. */
export function minimapTurnKey(turn: MinimapTurn): string {
	return `turn:${turn.startIndex}`
}

/**
 * The turns whose rows overlap the visible rows `first..last` (T3 Code highlights these), and
 * the current turn: the first visible one, else the last one starting above the viewport.
 */
export function getVisibleMinimapTurns(
	turns: readonly MinimapTurn[],
	first: number,
	last: number,
): { inView: Set<number>; current: number | undefined } {
	const inView = new Set<number>()
	let current: number | undefined
	turns.forEach((turn, i) => {
		const end = turns[i + 1] ? Math.max(turn.endIndex, turns[i + 1].startIndex - 1) : Number.MAX_SAFE_INTEGER
		if (turn.startIndex <= last && end >= first) {
			inView.add(i)
			current ??= i
		}
	})
	if (current === undefined) {
		for (const [i, turn] of turns.entries()) {
			if (turn.startIndex <= first) {
				current = i
			}
		}
	}
	return { inView, current: current ?? (turns.length ? 0 : undefined) }
}

/** A strip's position on the rail, as a percent of its height (first at 0, last at 100). */
export function minimapTopPercent(index: number, count: number): number {
	if (count <= 1) {
		return 0
	}
	return (Math.max(0, Math.min(index, count - 1)) / (count - 1)) * 100
}

/** The turn under the pointer on a rail `railTop..railTop+railHeight` tall. */
export function minimapIndexFromPointer(count: number, railTop: number, railHeight: number, pointerY: number): number | null {
	if (count <= 0 || railHeight <= 0) {
		return null
	}
	if (count === 1) {
		return 0
	}
	const progress = Math.max(0, Math.min(1, (pointerY - railTop) / railHeight))
	return Math.round(progress * (count - 1))
}

/** The preview's last line: what the turn did, or what it's waiting for. */
export function minimapTurnStatus(turn: MinimapTurn): string | undefined {
	if (turn.streaming) {
		return "Working…"
	}
	if (turn.attention === "approval") {
		return "Waiting for your approval"
	}
	if (turn.attention === "question") {
		return "Waiting for your answer"
	}
	const parts: string[] = []
	if (turn.tools) {
		parts.push(`${turn.tools} tool${turn.tools === 1 ? "" : "s"}`)
	}
	if (turn.errors) {
		parts.push(turn.attention === "error" ? "ended on an error" : `${turn.errors} error${turn.errors === 1 ? "" : "s"}`)
	}
	return parts.join(" · ") || undefined
}
