import type { ClineMessage } from "@shared/ExtensionMessage"
import { describe, expect, it } from "vitest"
import { getCurrentMinimapItem, getMinimapItems } from "./minimapUtils"

const say = (ts: number, sayType: ClineMessage["say"], text?: string, partial?: boolean): ClineMessage => ({
	ts,
	type: "say",
	say: sayType,
	text,
	partial,
})

describe("getMinimapItems", () => {
	it("maps user messages and assistant replies, skipping tool/noise rows", () => {
		const rows: (ClineMessage | ClineMessage[])[] = [
			say(1, "api_req_started", "{}"),
			say(2, "user_feedback", "What does this do?"),
			say(3, "reasoning", "thinking..."),
			[say(4, "tool", "{}"), say(5, "tool", "{}")],
			say(6, "text", "It parses the config."),
			say(7, "text", "   "),
			{ ts: 8, type: "ask", ask: "plan_mode_respond", text: JSON.stringify({ response: "Here is the answer" }) },
			say(9, "completion_result", "Done", true),
		]

		expect(getMinimapItems(rows)).toEqual([
			{ index: 1, ts: 2, role: "user", snippet: "What does this do?", streaming: false },
			{ index: 4, ts: 6, role: "agent", snippet: "It parses the config.", streaming: false },
			{ index: 6, ts: 8, role: "agent", snippet: "Here is the answer", streaming: false },
			{ index: 7, ts: 9, role: "agent", snippet: "Done", streaming: true },
		])
	})

	it("flattens whitespace and truncates long snippets", () => {
		const [item] = getMinimapItems([say(1, "text", `a\n\n${"b".repeat(300)}`)])
		expect(item.snippet.startsWith("a b")).toBe(true)
		expect(item.snippet.length).toBe(140)
		expect(item.snippet.endsWith("…")).toBe(true)
	})
})

describe("getCurrentMinimapItem", () => {
	const items = getMinimapItems([say(1, "user_feedback", "u"), say(2, "tool", "{}"), say(3, "text", "a"), say(4, "text", "b")])

	it("picks the last item at or above the top row", () => {
		expect(getCurrentMinimapItem(items, 1)?.ts).toBe(1)
		expect(getCurrentMinimapItem(items, 2)?.ts).toBe(3)
		expect(getCurrentMinimapItem(items, 99)?.ts).toBe(4)
	})

	it("falls back to the first item", () => {
		expect(getCurrentMinimapItem(items, -1)?.ts).toBe(1)
		expect(getCurrentMinimapItem([], 3)).toBeUndefined()
	})
})
