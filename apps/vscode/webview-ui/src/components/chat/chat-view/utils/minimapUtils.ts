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

/**
 * Maps rendered messages (including members of grouped rows) to their row index. With `fromTs`,
 * only the rows from the one holding that message on (walking back from the end), which is all a
 * resumed scan looks at.
 */
function indexRows(rows: readonly (ClineMessage | ClineMessage[])[], fromTs?: number): Map<number, number> {
	let first = 0
	if (fromTs !== undefined) {
		// Rows are in transcript order: walk back to the first row that starts before the message.
		first = rows.length
		while (first > 0) {
			const row = rows[--first]
			if (((Array.isArray(row) ? row[0] : row)?.ts ?? 0) < fromTs) {
				break
			}
		}
	}
	const rowByTs = new Map<number, number>()
	for (let index = first; index < rows.length; index++) {
		const row = rows[index]
		for (const message of Array.isArray(row) ? row : [row]) {
			rowByTs.set(message.ts, index)
		}
	}
	return rowByTs
}

/**
 * What a scan leaves behind so the next one can pick up from the last turn's prompt: the turns
 * before it (finished, so they no longer change as the reply streams) and where it starts.
 */
export interface MinimapTurnCache {
	/** Transcript index the last turn started at; 0 when everything is still one turn. */
	resumeAt: number
	/** The turns before the last one, as the scan left them. */
	finished: MinimapTurn[]
	/** What the finished turns were derived from: the task and the messages around the resume point. */
	taskTs?: number
	firstTs?: number
	beforeTs?: number
	atTs?: number
	/** Row the last turn started at: finished turns' rows are only still right while it hasn't moved. */
	resumeRow?: number
}

export function createMinimapTurnCache(): MinimapTurnCache {
	return { resumeAt: 0, finished: [] }
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
 *
 * One pass over the transcript. With a `cache` (kept between calls on the same thread) the pass
 * starts at the previous last turn's prompt and reuses the turns before it, so a reply streaming
 * in costs the size of the last turn, not of the thread.
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
	cache?: MinimapTurnCache,
): MinimapTurn[] {
	// Pick up from the cache if what it was derived from is still there.
	let from = 0
	let finished: MinimapTurn[] = []
	if (
		cache &&
		cache.resumeAt > 0 &&
		cache.resumeAt < messages.length &&
		cache.taskTs === task?.ts &&
		cache.firstTs === messages[0].ts &&
		cache.beforeTs === messages[cache.resumeAt - 1].ts &&
		cache.atTs === messages[cache.resumeAt].ts
	) {
		from = cache.resumeAt
		finished = cache.finished
	}
	const scanned = scanTurns(messages, rows, task, from, finished, cache?.resumeRow, turnActive)
	if (!scanned) {
		// The rows moved under the finished turns: start over.
		if (cache) {
			Object.assign(cache, createMinimapTurnCache())
		}
		return getMinimapTurns(messages, rows, task, turnActive, cache)
	}
	if (cache) {
		const resumeAt = scanned.lastStartedAt
		Object.assign(cache, {
			resumeAt,
			finished: scanned.turns.slice(0, -1),
			taskTs: task?.ts,
			firstTs: messages[0]?.ts,
			beforeTs: messages[resumeAt - 1]?.ts,
			atTs: messages[resumeAt]?.ts,
			resumeRow: scanned.turns.at(-1)?.startIndex,
		})
	}
	return scanned.turns
}

function scanTurns(
	messages: readonly ClineMessage[],
	rows: readonly (ClineMessage | ClineMessage[])[],
	task: ClineMessage | undefined,
	from: number,
	finished: MinimapTurn[],
	resumeRow: number | undefined,
	turnActive: boolean | undefined,
): { turns: MinimapTurn[]; lastStartedAt: number } | undefined {
	const turns: MinimapTurn[] = [...finished]
	const rowByTs = indexRows(rows, from > 0 ? messages[from].ts : undefined)
	let turn: MinimapTurn | undefined
	// What the turn's reply ended on, to flag a turn left waiting or failed.
	let last: ClineMessage | undefined
	// Per turn, the last rendered message that isn't bookkeeping: what a finished turn ended on.
	const endedOn = new Map<MinimapTurn, ClineMessage>()
	let lastStartedAt = 0
	const start = (index: number, ts: number, prompt: string, messageIndex: number) => {
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
		lastStartedAt = messageIndex
		turns.push(turn)
	}
	if (task && from === 0) {
		start(rowByTs.get(task.ts) ?? 0, task.ts, userSnippet(task), 0)
	}

	// Nearest rendered row at or after message `from`, from a table built the first time it's asked.
	let nextRows: (number | undefined)[] | undefined
	const nextRenderedRow = (at: number): number | undefined => {
		if (!nextRows) {
			nextRows = new Array(messages.length + 1)
			for (let i = messages.length - 1; i >= from; i--) {
				nextRows[i] = rowByTs.get(messages[i].ts) ?? nextRows[i + 1]
			}
		}
		return nextRows[at]
	}

	for (let messageIndex = from; messageIndex < messages.length; messageIndex++) {
		const message = messages[messageIndex]
		const row = rowByTs.get(message.ts)
		if (isUserMessage(message)) {
			// A hidden user message (the echo of a selected followup option) jumps to the
			// question row that shows the selection, else to the next rendered row.
			const previous = messages[messageIndex - 1]
			const optionRow = previous?.type === "ask" ? rowByTs.get(previous.ts) : undefined
			const index = row ?? optionRow ?? nextRenderedRow(messageIndex + 1)
			if (index !== undefined) {
				start(index, message.ts, userSnippet(message), messageIndex)
			}
			continue
		}
		if (!turn) {
			// Agent output before any prompt (no task row): a turn without a prompt.
			if (row === undefined) {
				continue
			}
			start(row, message.ts, "", messageIndex)
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
			if (row !== undefined) {
				endedOn.set(current, message)
			}
		}
		if (row !== undefined && row > current.endIndex) {
			current.endIndex = row
		}
	}

	// The first turn of a resumed scan starts where the cached one did; if its row moved, the
	// finished turns' rows can't be trusted.
	if (from > 0 && turns[finished.length]?.startIndex !== resumeRow) {
		return undefined
	}

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
	// A turn that ended on an error (rather than recovering) is flagged wherever it is. The turns
	// carried over from the cache were settled when they were scanned.
	for (let i = finished.length; i < turns.length; i++) {
		const item = turns[i]
		if (item.errors === 0 || item.attention) {
			continue
		}
		const ended = i === turns.length - 1 ? last : endedOn.get(item)
		if (ended && isError(ended)) {
			item.attention = "error"
		}
	}
	return { turns, lastStartedAt }
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
