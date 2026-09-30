import type { ClineMessage } from "@shared/ExtensionMessage"
import { describe, expect, it } from "vitest"
import { filterVisibleMessages, groupLowStakesTools, groupMessages } from "./messageUtils"
import { getCurrentMinimapItem, getMinimapItems, type MinimapItem, minimapItemKey } from "./minimapUtils"

const say = (ts: number, sayType: ClineMessage["say"], text?: string, partial?: boolean): ClineMessage => ({
	ts,
	type: "say",
	say: sayType,
	text,
	partial,
})

// Rows that render every message: the transcript is just the rows flattened.
const fromRows = (rows: (ClineMessage | ClineMessage[])[], task?: ClineMessage): MinimapItem[] =>
	getMinimapItems(rows.flat(), rows, task)

const fromRowsWith = (rows: (ClineMessage | ClineMessage[])[], turnActive: boolean): MinimapItem[] =>
	getMinimapItems(rows.flat(), rows, undefined, turnActive)

// The real ChatView pipeline from the unfiltered transcript to the rendered rows.
const render = (messages: ClineMessage[]) => groupLowStakesTools(groupMessages(filterVisibleMessages(messages)))

describe("getMinimapItems", () => {
	it("alternates one user square and one agent square per turn", () => {
		const rows: (ClineMessage | ClineMessage[])[] = [
			say(2, "reasoning", "thinking..."),
			say(3, "text", "First reply"),
			[say(4, "tool", "{}"), say(5, "tool", "{}")],
			say(6, "completion_result", "Turn one done"),
			say(7, "user_feedback", "What does this do?"),
			say(8, "text", "It parses the config."),
			say(9, "text", "   "),
			{ ts: 10, type: "ask", ask: "plan_mode_respond", text: JSON.stringify({ response: "Here is the answer" }) },
		]

		const items = fromRows(rows, say(1, "task", "Fix the bug"))
		expect(items.map((item) => item.role)).toEqual(["user", "agent", "user", "agent"])
		expect(items).toEqual([
			{ index: 0, startIndex: -1, ts: 1, role: "user", snippet: "Fix the bug", streaming: false },
			{ index: 3, startIndex: 0, ts: 6, role: "agent", snippet: "Turn one done", streaming: false },
			{ index: 4, startIndex: 4, ts: 7, role: "user", snippet: "What does this do?", streaming: false },
			{ index: 7, startIndex: 5, ts: 10, role: "agent", snippet: "Here is the answer", streaming: false },
		])
	})

	it("uses the last agent row as the jump target and the last agent text as the snippet", () => {
		const items = fromRows([
			say(1, "user_feedback", "go"),
			say(2, "text", "Looking around"),
			[say(3, "tool", "{}"), say(4, "tool", "{}")],
		])
		expect(items[1]).toMatchObject({ index: 2, startIndex: 1, ts: 4, snippet: "Looking around" })
	})

	it("describes tool-only turns", () => {
		const items = fromRows([say(1, "user_feedback", "go"), [say(2, "tool", "{}")]])
		expect(items[1]).toMatchObject({ role: "agent", snippet: "Used tools", streaming: false })
	})

	it("shows an in-progress turn only once the agent has produced something", () => {
		expect(fromRows([say(1, "user_feedback", "go")]).map((item) => item.role)).toEqual(["user"])

		const items = fromRows([say(1, "user_feedback", "go"), say(2, "text", "Partial", true)])
		expect(items[1]).toMatchObject({ role: "agent", snippet: "Partial", streaming: true })
	})

	it("keeps the in-progress reply streaming, with the same key, while its messages complete one by one", () => {
		// A streaming turn: each message goes partial -> complete, then the next one appears.
		const snapshots: (ClineMessage | ClineMessage[])[][] = [
			[say(1, "user_feedback", "go"), say(2, "text", "Look", true)],
			[say(1, "user_feedback", "go"), say(2, "text", "Looking")],
			[say(1, "user_feedback", "go"), say(2, "text", "Looking"), [say(3, "tool", "{}", true)]],
			[say(1, "user_feedback", "go"), say(2, "text", "Looking"), [say(3, "tool", "{}")]],
			[say(1, "user_feedback", "go"), say(2, "text", "Looking"), [say(3, "tool", "{}")], say(4, "text", "Fo", true)],
		]
		const replies = snapshots.map((rows) => fromRowsWith(rows, true)[1])
		expect(replies.map((reply) => reply.streaming)).toEqual([true, true, true, true, true])
		expect(new Set(replies.map(minimapItemKey)).size).toBe(1)
		// The ts follows the latest message, so it can't serve as the square's identity.
		expect(new Set(replies.map((reply) => reply.ts)).size).toBeGreaterThan(1)
	})

	it("stops streaming when the turn ends, even on a partial tail, and never marks earlier turns", () => {
		const rows = [
			say(1, "user_feedback", "a"),
			say(2, "text", "one", true),
			say(3, "user_feedback", "b"),
			say(4, "text", "two"),
		]
		expect(fromRowsWith(rows, false).map((item) => item.streaming)).toEqual([false, false, false, false])
		expect(fromRowsWith(rows, true).map((item) => item.streaming)).toEqual([false, false, false, true])
	})

	it("does not add an agent square between consecutive user messages", () => {
		const items = fromRows([say(1, "user_feedback", "a"), say(2, "user_feedback", "b"), say(3, "text", "reply")])
		expect(items.map((item) => item.role)).toEqual(["user", "user", "agent"])
	})

	it("labels attachment-only user messages", () => {
		const [item] = fromRows([{ ...say(1, "user_feedback", ""), images: ["data:image/png;base64,x"] }])
		expect(item.snippet).toBe("(attachments)")
	})

	it("keeps the user square of a selected followup option whose echo is hidden", () => {
		const question: ClineMessage = {
			ts: 3,
			type: "ask",
			ask: "followup",
			text: JSON.stringify({ question: "Which file?", options: ["a.ts", "b.ts"], selected: "a.ts" }),
		}
		const messages = [
			say(1, "user_feedback", "go"),
			say(2, "text", "Let me ask"),
			question,
			say(4, "user_feedback", "a.ts"),
			say(5, "text", "Editing a.ts"),
		]
		const rows = render(messages)
		expect(rows.some((row) => !Array.isArray(row) && row.ts === 4)).toBe(false)

		const items = getMinimapItems(messages, rows)
		expect(items.map((item) => [item.role, item.snippet])).toEqual([
			["user", "go"],
			["agent", "Which file?"],
			["user", "a.ts"],
			["agent", "Editing a.ts"],
		])
		// The hidden answer jumps to the question row that shows the selection.
		const questionRow = rows.findIndex((row) => !Array.isArray(row) && row.ts === 3)
		expect(items[2]).toMatchObject({ index: questionRow, startIndex: questionRow })
		expect(items[3].index).toBe(rows.findIndex((row) => !Array.isArray(row) && row.ts === 5))
	})

	it("maps hidden turn messages onto the nearest rendered row after them", () => {
		const messages = [
			say(1, "user_feedback", "go"),
			say(2, "api_req_started", "{}"),
			say(3, "text", "Done"),
			say(4, "checkpoint_created"),
		]
		const rows = render(messages)
		const items = getMinimapItems(messages, rows)
		const textRow = rows.findIndex((row) => !Array.isArray(row) && row.ts === 3)
		expect(items[1]).toMatchObject({ index: textRow, startIndex: textRow, ts: 3, snippet: "Done" })
	})

	it("previews agent text inside a grouped row and jumps to that row", () => {
		const items = fromRows([
			say(1, "user_feedback", "go"),
			say(2, "text", "Earlier text"),
			[say(3, "browser_action_launch", "https://x.dev"), say(4, "text", "Browsing now"), say(5, "browser_action", "{}")],
		])
		expect(items[1]).toMatchObject({ index: 2, ts: 5, snippet: "Browsing now" })
	})

	it("flattens whitespace and truncates long snippets", () => {
		const [item] = fromRows([say(1, "text", `a\n\n${"b".repeat(300)}`)])
		expect(item.snippet.startsWith("a b")).toBe(true)
		expect(item.snippet.length).toBe(140)
		expect(item.snippet.endsWith("…")).toBe(true)
	})
})

describe("getCurrentMinimapItem", () => {
	const items = fromRows(
		[say(2, "tool", "{}"), say(3, "text", "a"), say(4, "user_feedback", "u"), say(5, "tool", "{}"), say(6, "text", "b")],
		say(1, "task", "t"),
	)

	it("picks the square whose turn covers the top row", () => {
		expect(getCurrentMinimapItem(items, 0)?.ts).toBe(3)
		expect(getCurrentMinimapItem(items, 1)?.ts).toBe(3)
		expect(getCurrentMinimapItem(items, 2)?.ts).toBe(4)
		expect(getCurrentMinimapItem(items, 3)?.ts).toBe(6)
		expect(getCurrentMinimapItem(items, 99)?.ts).toBe(6)
	})

	it("keeps the last turn current at the live end as its rows grow", () => {
		let rows: (ClineMessage | ClineMessage[])[] = [say(2, "text", "a"), say(3, "user_feedback", "u")]
		const keys: (string | undefined)[] = []
		for (let ts = 4; ts < 12; ts++) {
			rows = [...rows, ts % 2 ? say(ts, "text", `t${ts}`, true) : [say(ts, "tool", "{}")]]
			const current = getCurrentMinimapItem(fromRows(rows, say(1, "task", "t")), Number.MAX_SAFE_INTEGER)
			keys.push(current && minimapItemKey(current))
		}
		expect(new Set(keys)).toEqual(new Set(["agent:2"]))
	})

	it("falls back to the first item", () => {
		expect(getCurrentMinimapItem(items, -5)?.ts).toBe(1)
		expect(getCurrentMinimapItem([], 3)).toBeUndefined()
	})
})
