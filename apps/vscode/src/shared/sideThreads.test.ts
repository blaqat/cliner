import { describe, expect, it } from "vitest"
import type { ClineMessage } from "./ExtensionMessage"
import { reservedCommandNameError } from "./scripts"
import { sideThreadAnswer, sideThreadAnswerText, sideThreadOwnMessages, sideThreadTitle } from "./sideThreads"

const row = (ts: number, fields: Partial<ClineMessage> = {}): ClineMessage => ({ ts, type: "say", say: "text", ...fields })

describe("sideThreadTitle", () => {
	it("uses the first non-empty line, trimmed and shortened", () => {
		expect(sideThreadTitle("\n  Is a 500ms   base delay too short?\nmore")).toBe("Is a 500ms base delay too short?")
		const long = sideThreadTitle("x".repeat(80))
		expect(long).toHaveLength(60)
		expect(long.endsWith("…")).toBe(true)
	})

	it("falls back when there's no text", () => {
		expect(sideThreadTitle("   ")).toBe("Side thread")
		expect(sideThreadTitle(undefined, "Side question")).toBe("Side question")
	})
})

describe("sideThreadOwnMessages", () => {
	it("drops the copy of Main, by transcript index and by position for live rows", () => {
		const messages = [
			row(1, { sdkMessageIndex: 0 }),
			row(2, { sdkMessageIndex: 3 }),
			row(3, { say: "user_feedback" }),
			row(4),
			row(5, { sdkMessageIndex: 5 }),
		]
		expect(sideThreadOwnMessages(messages, 4).map((message) => message.ts)).toEqual([3, 4, 5])
	})

	it("keeps everything for an older aside with no fork index", () => {
		expect(sideThreadOwnMessages([row(1, { sdkMessageIndex: 0 })], undefined)).toHaveLength(1)
	})
})

describe("sideThreadAnswer", () => {
	it("finds the latest answer after the latest question", () => {
		const answer = row(3, { text: "No, it fits." })
		expect(sideThreadAnswer([row(1, { say: "user_feedback", text: "q" }), row(2, { say: "api_req_started" }), answer])).toBe(
			answer,
		)
		expect(sideThreadAnswer([answer, row(4, { say: "user_feedback", text: "next" })])).toBeUndefined()
	})

	it("reads plan and followup replies from their JSON", () => {
		const plan = row(1, {
			type: "ask",
			ask: "plan_mode_respond",
			say: undefined,
			text: JSON.stringify({ response: "Keep it." }),
		})
		expect(sideThreadAnswerText(sideThreadAnswer([plan]))).toBe("Keep it.")
	})
})

describe("reservedCommandNameError", () => {
	it("reserves side and btw only", () => {
		expect(reservedCommandNameError("side")).toContain("/side")
		expect(reservedCommandNameError("BTW")).toContain("/btw")
		expect(reservedCommandNameError("sidecar")).toBeUndefined()
	})
})
