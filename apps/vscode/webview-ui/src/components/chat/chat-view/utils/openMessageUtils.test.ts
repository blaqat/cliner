import type { ClineMessage } from "@shared/ExtensionMessage"
import { describe, expect, it } from "vitest"
import { findOpenMessageIndex } from "./openMessageUtils"

const row = (ts: number, extra: Partial<ClineMessage>): ClineMessage => ({ ts, type: "say", ...extra })

const messages: ClineMessage[] = [
	row(1, { say: "task", text: "do it", sdkMessageIndex: 0 }),
	row(2, { say: "text", text: "first block", sdkMessageIndex: 1 }),
	row(3, { say: "reasoning", text: "thinking", sdkMessageIndex: 1 }),
	row(4, { say: "text", text: "second block", sdkMessageIndex: 1 }),
	row(5, { say: "completion_result", text: "all done", sdkMessageIndex: 2, sdkToolCallId: "call_done" }),
]

describe("findOpenMessageIndex", () => {
	it("opens a completion row by its tool call", () => {
		expect(findOpenMessageIndex(messages, { messageIndex: 2, toolCallId: "call_done", text: "all done" })).toBe(4)
	})

	it("opens the anchored block of a multi-block message", () => {
		expect(findOpenMessageIndex(messages, { messageIndex: 1, block: 1, text: "second block" })).toBe(3)
		expect(findOpenMessageIndex(messages, { messageIndex: 1, block: 0, text: "first block" })).toBe(1)
	})

	it("falls back to the text, then to the message's first row, for unanchored or stale anchors", () => {
		expect(findOpenMessageIndex(messages, { messageIndex: 1, block: 0, text: "second block" })).toBe(3)
		expect(findOpenMessageIndex(messages, { messageIndex: 1, text: "" })).toBe(1)
		expect(findOpenMessageIndex(messages, { messageIndex: 9, text: "do it" })).toBe(0)
		expect(findOpenMessageIndex(messages, { messageIndex: 9, text: "" })).toBe(-1)
	})
})
