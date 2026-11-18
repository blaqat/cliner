import { splitThinkTags } from "@shared/think-tags"
import { describe, expect, it } from "vitest"

describe("splitThinkTags", () => {
	it("leaves ordinary text alone", () => {
		expect(splitThinkTags("Just an answer", false)).toEqual({ thinkingOpen: false, answer: "Just an answer" })
		expect(splitThinkTags("Mentions </think> mid-answer <think>", false).thinking).toBeUndefined()
	})

	it("splits a closed think block from the answer", () => {
		expect(splitThinkTags("<think>Let me see.</think>\n\nThe answer", false)).toEqual({
			thinking: "Let me see.",
			thinkingOpen: false,
			answer: "The answer",
		})
	})

	it("treats text before a lone closing tag as thinking, for templates that open it themselves", () => {
		expect(splitThinkTags("Weighing options. </think>\n\nThe answer", false)).toEqual({
			thinking: "Weighing options.",
			thinkingOpen: false,
			answer: "The answer",
		})
	})

	it("keeps an unclosed block open while it streams, and closed once the reply ends", () => {
		expect(splitThinkTags("<think>Still going", true)).toEqual({ thinking: "Still going", thinkingOpen: true, answer: "" })
		expect(splitThinkTags("<think>Never closed", false)).toEqual({
			thinking: "Never closed",
			thinkingOpen: false,
			answer: "",
		})
	})
})
