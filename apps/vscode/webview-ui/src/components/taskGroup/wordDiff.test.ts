import { describe, expect, it } from "vitest"
import { pairChangedLines, wordDiff } from "./wordDiff"

describe("wordDiff", () => {
	it("marks only the words an edit touched", () => {
		expect(wordDiff("Check the dashboard daily.", "Check the release dashboard daily.")).toEqual({
			before: [{ text: "Check the dashboard daily.", changed: false }],
			after: [
				{ text: "Check the ", changed: false },
				{ text: "release ", changed: true },
				{ text: "dashboard daily.", changed: false },
			],
		})
	})
	it("gives up when the lines share no words or are too long to compare", () => {
		expect(wordDiff("alpha beta", "gamma delta")).toBeUndefined()
		expect(wordDiff("word ".repeat(400), "word ".repeat(400).replace("word", "other"))).toBeUndefined()
	})
	it("pairs removed and added lines within a hunk", () => {
		const parts = pairChangedLines([
			{ kind: "context", text: "a" },
			{ kind: "remove", text: "one two" },
			{ kind: "remove", text: "three" },
			{ kind: "add", text: "one 2" },
			{ kind: "context", text: "b" },
		])
		expect([...parts.keys()]).toEqual([1, 3])
		expect(parts.get(3)).toEqual([
			{ text: "one ", changed: false },
			{ text: "2", changed: true },
		])
	})
})
