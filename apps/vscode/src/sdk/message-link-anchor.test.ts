import type { ClineMessage } from "@shared/ExtensionMessage"
import { describe, expect, it } from "vitest"
import { findMessageLinkTarget, resolveLinkedMessageText } from "./message-link-anchor"
import { sdkMessagesToClineMessages } from "./message-translator"
import type { SdkInitialMessages } from "./session-host"

const transcript = [
	{ role: "user", content: "Fix the login loop" },
	{
		role: "assistant",
		content: [
			{ type: "text", text: "First I will look." },
			{ type: "text", text: "Second block of the same message." },
			{ type: "tool_use", id: "call_done", name: "attempt_completion", input: { result: "All fixed, tests pass." } },
		],
	},
	{ role: "user", content: [{ type: "tool_result", tool_use_id: "call_done", content: "ok" }] },
	{ role: "user", content: "Thanks, now submit" },
	{
		role: "assistant",
		content: [{ type: "tool_use", id: "call_submit", name: "submit_and_exit", input: { summary: "Submitted." } }],
	},
	{ role: "user", content: [{ type: "tool_result", tool_use_id: "call_submit", content: "ok" }] },
] as unknown as SdkInitialMessages

// What the chat renders for the persisted transcript.
const visible = (): ClineMessage[] => sdkMessagesToClineMessages(transcript as never)

describe("message link anchors", () => {
	it("anchors a completion-tool row by its call id and resolves to the tool input text", () => {
		const rows = visible()
		for (const [toolCallId, expected] of [
			["call_done", "All fixed, tests pass."],
			["call_submit", "Submitted."],
		] as const) {
			const row = rows.find((message) => message.sdkToolCallId === toolCallId && message.say === "completion_result")!
			const { messageIndex, anchor } = findMessageLinkTarget(transcript, rows, row.ts)
			expect(anchor).toEqual({ toolCallId })
			expect(resolveLinkedMessageText(transcript, messageIndex!, anchor)).toEqual({ role: "assistant", text: expected })
		}
	})

	it("anchors each block of a multi-block message to its own row", () => {
		const rows = visible()
		const second = rows.find((message) => message.text === "Second block of the same message.")!
		const first = rows.find((message) => message.text === "First I will look.")!
		const secondTarget = findMessageLinkTarget(transcript, rows, second.ts)
		const firstTarget = findMessageLinkTarget(transcript, rows, first.ts)
		expect(secondTarget.anchor).toEqual({ block: 1 })
		expect(firstTarget.anchor).toEqual({ block: 0 })
		expect(resolveLinkedMessageText(transcript, secondTarget.messageIndex!, secondTarget.anchor)?.text).toBe(
			"Second block of the same message.",
		)
		expect(resolveLinkedMessageText(transcript, firstTarget.messageIndex!, firstTarget.anchor)?.text).toBe(
			"First I will look.",
		)
	})

	it("keeps a plain single-row link anchor-free and resolves user rows", () => {
		const rows = visible()
		const user = rows.find((message) => message.text === "Thanks, now submit")!
		const { messageIndex, anchor } = findMessageLinkTarget(transcript, rows, user.ts)
		expect(anchor).toEqual({})
		expect(resolveLinkedMessageText(transcript, messageIndex!, anchor)).toEqual({
			role: "user",
			text: "Thanks, now submit",
		})
	})

	it("resolves an old index-only link to all the message's text rows", () => {
		const resolved = resolveLinkedMessageText(transcript, 1, {})
		expect(resolved?.text).toBe("First I will look.\n\nSecond block of the same message.")
	})

	it("resolves an old link that pointed at a completion tool-result message to its completion text", () => {
		const row = visible().find((message) => message.sdkToolCallId === "call_done" && message.say === "completion_result")!
		expect(resolveLinkedMessageText(transcript, row.sdkMessageIndex!, {})?.text).toContain("All fixed, tests pass.")
	})

	it("returns nothing for an unknown anchor", () => {
		expect(resolveLinkedMessageText(transcript, 1, { toolCallId: "nope" })).toBeUndefined()
		expect(resolveLinkedMessageText(transcript, 1, { block: 9 })).toBeUndefined()
	})
})
