import type { ClineMessage } from "@shared/ExtensionMessage"
import { describe, expect, it } from "vitest"
import { filterVisibleMessages } from "./chat-view/utils/messageUtils"
import { isNotebookRunFollower, notebookTurnRun } from "./notebookTurnRows"

const review = (ts: number, taskGroupId: string): ClineMessage => ({
	ts,
	type: "say",
	say: "notebook_changes",
	text: JSON.stringify({ taskGroupId, threadId: "t1", status: "pending", changes: [] }),
})
const text = (ts: number): ClineMessage => ({ ts, type: "say", say: "text", text: "hi" })
const apiReq = (ts: number): ClineMessage => ({ ts, type: "say", say: "api_req_started", text: "{}" })

describe("notebookTurnRun", () => {
	it("joins a turn's notes, About you and skills rows into one, led by the first", () => {
		const messages = [text(1), review(2, "g1"), apiReq(3), review(4, "about-you"), review(5, "skill-drafts"), text(6)]
		expect(notebookTurnRun(messages, 3).map((message) => message.ts)).toEqual([2, 4, 5])
		expect(isNotebookRunFollower(messages, 1)).toBe(false)
		expect(isNotebookRunFollower(messages, 3)).toBe(true)
		expect(isNotebookRunFollower(messages, 4)).toBe(true)
		expect(filterVisibleMessages(messages).map((message) => message.ts)).toEqual([1, 2, 6])
	})

	it("starts a new run when a kind repeats (older histories had a row per turn)", () => {
		const messages = [review(1, "g1"), review(2, "g1"), review(3, "about-you")]
		expect(notebookTurnRun(messages, 0).map((message) => message.ts)).toEqual([1])
		expect(notebookTurnRun(messages, 1).map((message) => message.ts)).toEqual([2, 3])
		expect(notebookTurnRun(messages, 2).map((message) => message.ts)).toEqual([2, 3])
	})

	it("keeps rows of different turns apart", () => {
		const messages = [review(1, "g1"), text(2), review(3, "about-you")]
		expect(isNotebookRunFollower(messages, 2)).toBe(false)
	})
})
