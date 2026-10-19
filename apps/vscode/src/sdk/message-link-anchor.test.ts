import type { ClineMessage } from "@shared/ExtensionMessage"
import { describe, expect, it } from "vitest"
import { findMessageLinkTarget, resolveLinkedMessageText } from "./message-link-anchor"
import { sdkMessagesToClineMessages } from "./message-translator"
import { sanitizeSdkUserMessagesForDisplay } from "./sdk-task-history"
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

// One test per row type that shows "Copy link": each must yield a link, and the link must resolve to the row's text.
describe("every row type with Copy link yields a resolvable link", () => {
	const inferred = [
		{ role: "user", content: "Is it done?" },
		{ role: "assistant", content: [{ type: "text", text: "Yes, all done here." }] },
	] as unknown as SdkInitialMessages

	function linkFor(messages: SdkInitialMessages, rows: ClineMessage[], match: (row: ClineMessage) => boolean) {
		const row = rows.find(match)!
		expect(row).toBeDefined()
		const target = findMessageLinkTarget(messages, rows, row.ts)
		expect(target.messageIndex).toBeDefined()
		return { row, ...target, resolved: resolveLinkedMessageText(messages, target.messageIndex!, target.anchor) }
	}

	it("task / user_feedback rows", () => {
		const rows = sdkMessagesToClineMessages(transcript as never)
		expect(linkFor(transcript, rows, (row) => row.say === "task").resolved).toEqual({
			role: "user",
			text: "Fix the login loop",
		})
		expect(linkFor(transcript, rows, (row) => row.say === "user_feedback").resolved?.role).toBe("user")
	})

	it("text rows", () => {
		const rows = sdkMessagesToClineMessages(transcript as never)
		expect(linkFor(transcript, rows, (row) => row.text === "First I will look.").resolved?.text).toBe("First I will look.")
	})

	it("attempt_completion and submit_and_exit rows", () => {
		const rows = sdkMessagesToClineMessages(transcript as never)
		expect(
			linkFor(transcript, rows, (row) => row.sdkToolCallId === "call_done" && row.say === "completion_result").resolved,
		).toEqual({
			role: "assistant",
			text: "All fixed, tests pass.",
		})
		expect(
			linkFor(transcript, rows, (row) => row.sdkToolCallId === "call_submit" && row.say === "completion_result").resolved,
		).toEqual({
			role: "assistant",
			text: "Submitted.",
		})
	})

	it("an inferred completion (turn ended on plain text) keeps its transcript position", () => {
		// Regression: the retag replaced the stamped text row, dropping sdkMessageIndex, so Copy link had nothing to link to.
		const rows = sdkMessagesToClineMessages(inferred as never)
		const completion = rows.find((row) => row.say === "completion_result" && row.text)!
		expect(completion.sdkMessageIndex).toBe(1)
		const link = linkFor(inferred, rows, (row) => row.say === "completion_result" && !!row.text)
		expect(link.messageIndex).toBe(1)
		expect(link.resolved).toEqual({ role: "assistant", text: "Yes, all done here." })
	})

	it("an inferred completion row of a live session (no persisted stamps) is matched against the transcript", () => {
		const live = sdkMessagesToClineMessages(inferred as never).map(
			({ sdkMessageIndex: _i, sdkToolCallId: _t, ...row }) => row,
		)
		const link = linkFor(inferred, live as ClineMessage[], (row) => row.say === "completion_result" && !!row.text)
		expect(link.resolved?.text).toBe("Yes, all done here.")
	})

	it("an inferred Ask-mode completion (plan_completion_result)", () => {
		const plan = [
			{ role: "user", content: '<user_input mode="plan">What would you change?</user_input>' },
			{ role: "assistant", content: [{ type: "text", text: "I would split the module." }] },
		] as unknown as SdkInitialMessages
		const rows = sdkMessagesToClineMessages(sanitizeSdkUserMessagesForDisplay(plan as never))
		expect(rows.some((row) => row.say === "plan_completion_result")).toBe(true)
		const link = linkFor(plan, rows, (row) => row.say === "plan_completion_result")
		expect(link.resolved).toEqual({ role: "assistant", text: "I would split the module." })
	})

	it("a follow-up question asked through ask_question (a live-only row)", () => {
		const asked = [
			{ role: "user", content: "Refactor it" },
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "call_q1", name: "ask_question", input: { question: "Which module?" } }],
			},
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "call_q1", content: "auth" }] },
			{
				role: "assistant",
				content: [
					{ type: "tool_use", id: "call_q2", name: "ask_followup_question", input: { question: "Which module?" } },
				],
			},
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "call_q2", content: "billing" }] },
		] as unknown as SdkInitialMessages
		const followup = (ts: number): ClineMessage => ({
			ts,
			type: "ask",
			ask: "followup",
			text: JSON.stringify({ question: "Which module?", options: ["auth", "billing"] }),
		})
		const rows = [...sdkMessagesToClineMessages(asked as never).slice(0, 1), followup(9001), followup(9002)]
		const first = findMessageLinkTarget(asked, rows, 9001)
		const second = findMessageLinkTarget(asked, rows, 9002)
		expect(first).toEqual({ messageIndex: 1, anchor: { toolCallId: "call_q1" } })
		expect(second).toEqual({ messageIndex: 3, anchor: { toolCallId: "call_q2" } })
		expect(resolveLinkedMessageText(asked, 1, first.anchor)).toEqual({ role: "assistant", text: "Which module?" })
	})

	it("a row with no transcript counterpart yields no link instead of a wrong one", () => {
		const rows: ClineMessage[] = [{ ts: 5, type: "say", say: "text", text: "never persisted" }]
		expect(findMessageLinkTarget(inferred, rows, 5)).toEqual({ anchor: {} })
	})
})
