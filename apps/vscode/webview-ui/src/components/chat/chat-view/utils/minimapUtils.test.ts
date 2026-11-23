import type { ClineMessage } from "@shared/ExtensionMessage"
import { describe, expect, it } from "vitest"
import { filterVisibleMessages, groupLowStakesTools, groupMessages } from "./messageUtils"
import {
	getMinimapKind,
	getMinimapTurns,
	getVisibleMinimapTurns,
	type MinimapTurn,
	minimapIndexFromPointer,
	minimapTopPercent,
	minimapTurnKey,
	minimapTurnStatus,
} from "./minimapUtils"

const say = (ts: number, sayType: ClineMessage["say"], text?: string, partial?: boolean): ClineMessage => ({
	ts,
	type: "say",
	say: sayType,
	text,
	partial,
})
const ask = (ts: number, askType: ClineMessage["ask"], text = "{}", partial?: boolean): ClineMessage => ({
	ts,
	type: "ask",
	ask: askType,
	text,
	partial,
})

// Rows that render every message: the transcript is just the rows flattened. As in ChatView,
// the task prompt renders as the first row but stays out of the transcript.
const fromRows = (rows: (ClineMessage | ClineMessage[])[], task?: ClineMessage, turnActive?: boolean): MinimapTurn[] =>
	getMinimapTurns(rows.flat(), task ? [task, ...rows] : rows, task, turnActive)

// The real ChatView pipeline from the unfiltered transcript to the rendered rows.
const render = (messages: ClineMessage[]) => groupLowStakesTools(groupMessages(filterVisibleMessages(messages)))

describe("getMinimapTurns", () => {
	it("makes one turn per prompt, the task prompt first, with the reply's latest text and tool count", () => {
		const rows: (ClineMessage | ClineMessage[])[] = [
			say(2, "reasoning", "thinking..."),
			say(3, "text", "First reply"),
			[say(4, "tool", "{}"), say(5, "tool", "{}")],
			say(6, "completion_result", "Turn one done"),
			say(7, "user_feedback", "What does this do?"),
			say(8, "text", "It parses the config."),
			say(9, "text", "   "),
			ask(10, "plan_mode_respond", JSON.stringify({ response: "Here is the answer" })),
		]
		expect(fromRows(rows, say(1, "task", "Fix the bug"))).toEqual([
			{
				index: 0,
				startIndex: 0,
				endIndex: 4,
				ts: 1,
				prompt: "Fix the bug",
				reply: "Turn one done",
				replyKind: "completion",
				tools: 2,
				errors: 0,
				streaming: false,
			},
			{
				index: 5,
				startIndex: 5,
				endIndex: 8,
				ts: 7,
				prompt: "What does this do?",
				reply: "Here is the answer",
				replyKind: "answer",
				tools: 0,
				errors: 0,
				streaming: false,
			},
		])
	})

	it("keeps a prompt with no reply yet as its own turn", () => {
		const turns = fromRows([say(1, "user_feedback", "a"), say(2, "user_feedback", "b"), say(3, "text", "reply")])
		expect(turns.map((turn) => [turn.prompt, turn.reply])).toEqual([
			["a", undefined],
			["b", "reply"],
		])
	})

	it("streams only the last turn, once it has a reply, with the same key while it grows", () => {
		const snapshots: (ClineMessage | ClineMessage[])[][] = [
			[say(1, "user_feedback", "go"), say(2, "text", "Look", true)],
			[say(1, "user_feedback", "go"), say(2, "text", "Looking")],
			[say(1, "user_feedback", "go"), say(2, "text", "Looking"), [say(3, "tool", "{}", true)]],
			[say(1, "user_feedback", "go"), say(2, "text", "Looking"), [say(3, "tool", "{}")], say(4, "text", "Fo", true)],
		]
		const turns = snapshots.map((rows) =>
			fromRows([say(0, "user_feedback", "first"), say(0.5, "text", "ok"), ...rows], undefined, true),
		)
		expect(turns.map((list) => list.map((turn) => turn.streaming))).toEqual(snapshots.map(() => [false, true]))
		expect(new Set(turns.map((list) => minimapTurnKey(list[1]))).size).toBe(1)
		// A prompt still waiting for its first output isn't "working" yet.
		expect(fromRows([say(1, "user_feedback", "go")], undefined, true)[0].streaming).toBe(false)
		expect(fromRows([say(1, "user_feedback", "go"), say(2, "text", "Partial", true)])[0].streaming).toBe(true)
	})

	it("flags a last turn waiting for an approval or an answer, and turns that ended on an error", () => {
		const approval = fromRows([
			say(1, "user_feedback", "run it"),
			say(2, "text", "Running"),
			ask(3, "command", "rm -rf build"),
		])
		expect(approval[0].attention).toBe("approval")
		expect(minimapTurnStatus(approval[0])).toBe("Waiting for your approval")

		const question = fromRows([
			say(1, "user_feedback", "go"),
			ask(2, "followup", JSON.stringify({ question: "Which file?" })),
		])
		expect(question[0]).toMatchObject({ attention: "question", reply: "Which file?", replyKind: "question" })

		const turns = fromRows([
			say(1, "user_feedback", "a"),
			say(2, "error", "boom"),
			say(3, "text", "Recovered"),
			say(4, "user_feedback", "b"),
			say(5, "text", "Trying"),
			ask(6, "api_req_failed", "429"),
			say(7, "user_feedback", "c"),
			say(8, "tool", "{}"),
			ask(9, "tool", "{}"),
		])
		expect(turns.map((turn) => turn.attention)).toEqual([undefined, "error", "approval"])
		expect(turns.map((turn) => turn.errors)).toEqual([1, 1, 0])
		expect(minimapTurnStatus(turns[0])).toBe("1 error")
		expect(minimapTurnStatus(turns[1])).toBe("ended on an error")
		// An approval answered by a later prompt isn't waiting any more.
		expect(fromRows([say(1, "user_feedback", "a"), ask(2, "tool", "{}"), say(3, "user_feedback", "b")])[0].attention).toBe(
			undefined,
		)
	})

	it("counts tool calls, commands, browser and MCP calls, not their partial updates", () => {
		const [turn] = fromRows([
			say(1, "user_feedback", "go"),
			say(2, "tool", "{}", true),
			say(2.5, "tool", "{}"),
			say(3, "command", "ls"),
			say(4, "command_output", "a b"),
			say(5, "browser_action_launch", "https://x.dev"),
			say(6, "use_mcp_server", "{}"),
			say(7, "text", "Done"),
		])
		expect(turn.tools).toBe(4)
		expect(minimapTurnStatus(turn)).toBe("4 tools")
	})

	it("labels attachment-only prompts", () => {
		const [turn] = fromRows([{ ...say(1, "user_feedback", ""), images: ["data:image/png;base64,x"] }])
		expect(turn.prompt).toBe("(attachments)")
	})

	it("keeps the turn of a selected followup option whose echo is hidden", () => {
		const question = ask(
			3,
			"followup",
			JSON.stringify({ question: "Which file?", options: ["a.ts", "b.ts"], selected: "a.ts" }),
		)
		const messages = [
			say(1, "user_feedback", "go"),
			say(2, "text", "Let me ask"),
			question,
			say(4, "user_feedback", "a.ts"),
			say(5, "text", "Editing a.ts"),
		]
		const rows = render(messages)
		expect(rows.some((row) => !Array.isArray(row) && row.ts === 4)).toBe(false)

		const turns = getMinimapTurns(messages, rows)
		expect(turns.map((turn) => [turn.prompt, turn.reply])).toEqual([
			["go", "Which file?"],
			["a.ts", "Editing a.ts"],
		])
		// The hidden answer jumps to the question row that shows the selection.
		const questionRow = rows.findIndex((row) => !Array.isArray(row) && row.ts === 3)
		expect(turns[1]).toMatchObject({ index: questionRow, startIndex: questionRow })
	})

	it("starts a turn without a prompt for agent output before any prompt", () => {
		const [turn] = fromRows([say(1, "text", "Hello")])
		expect(turn).toMatchObject({ index: 0, prompt: "", reply: "Hello" })
	})

	it("flattens whitespace and truncates long text", () => {
		const [turn] = fromRows([say(1, "user_feedback", `a\n\n${"b".repeat(400)}`)])
		expect(turn.prompt.startsWith("a b")).toBe(true)
		expect(turn.prompt.length).toBe(280)
		expect(turn.prompt.endsWith("…")).toBe(true)
	})

	it("handles a 300-turn thread quickly", () => {
		const rows: ClineMessage[] = []
		for (let i = 0; i < 300; i++) {
			rows.push(
				say(i * 3 + 1, "user_feedback", `turn ${i}`),
				say(i * 3 + 2, "tool", "{}"),
				say(i * 3 + 3, "text", `reply ${i}`),
			)
		}
		const started = performance.now()
		const turns = fromRows(rows, undefined, true)
		expect(performance.now() - started).toBeLessThan(100)
		expect(turns).toHaveLength(300)
		expect(turns.at(-1)).toMatchObject({ prompt: "turn 299", reply: "reply 299", streaming: true })
	})
})

describe("getVisibleMinimapTurns", () => {
	// Turns start at rows 0, 3 and 6.
	const turns = fromRows(
		[
			say(2, "tool", "{}"),
			say(3, "text", "a"),
			say(4, "user_feedback", "u"),
			say(5, "tool", "{}"),
			say(6, "text", "b"),
			say(7, "user_feedback", "v"),
			say(8, "text", "c"),
		],
		say(1, "task", "t"),
	)

	it("marks every turn overlapping the visible rows, the first one current", () => {
		expect(getVisibleMinimapTurns(turns, 0, 1)).toEqual({ inView: new Set([0]), current: 0 })
		expect(getVisibleMinimapTurns(turns, 2, 4)).toEqual({ inView: new Set([0, 1]), current: 0 })
		expect(getVisibleMinimapTurns(turns, 4, 99)).toEqual({ inView: new Set([1, 2]), current: 1 })
	})

	it("keeps the last turn in view at the live end", () => {
		const live = getVisibleMinimapTurns(turns, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)
		expect(live).toEqual({ inView: new Set([2]), current: 2 })
	})

	it("falls back to the first turn", () => {
		expect(getVisibleMinimapTurns(turns, -5, -1).current).toBe(0)
		expect(getVisibleMinimapTurns([], 0, 3).current).toBeUndefined()
	})
})

describe("rail geometry", () => {
	it("spreads strips from top to bottom and maps the pointer back to the nearest one", () => {
		expect([0, 1, 2, 3, 4].map((index) => minimapTopPercent(index, 5))).toEqual([0, 25, 50, 75, 100])
		expect(minimapTopPercent(0, 1)).toBe(0)
		expect(minimapIndexFromPointer(5, 100, 80, 100)).toBe(0)
		expect(minimapIndexFromPointer(5, 100, 80, 131)).toBe(2)
		expect(minimapIndexFromPointer(5, 100, 80, 500)).toBe(4)
		expect(minimapIndexFromPointer(0, 100, 80, 120)).toBeNull()
	})
})

describe("getMinimapKind", () => {
	it("maps each turn-ending block to its kind", () => {
		expect(getMinimapKind(say(1, "completion_result", "done"))).toBe("completion")
		expect(getMinimapKind(ask(1, "completion_result", ""))).toBe("completion")
		expect(getMinimapKind(say(1, "plan_completion_result", "answer"))).toBe("answer")
		expect(getMinimapKind(ask(1, "plan_mode_respond"))).toBe("answer")
		expect(getMinimapKind(ask(1, "followup"))).toBe("question")
		expect(getMinimapKind(say(1, "text", "hi"))).toBe("agent")
		expect(getMinimapKind(ask(1, "command", "ls"))).toBe("agent")
	})
})
