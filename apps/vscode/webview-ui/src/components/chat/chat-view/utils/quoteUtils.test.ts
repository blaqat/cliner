import { describe, expect, it } from "vitest"
import { formatMessageWithQuotes } from "./quoteUtils"

describe("formatMessageWithQuotes", () => {
	it("returns the trimmed text when there are no quotes", () => {
		expect(formatMessageWithQuotes("  hello  ", [])).toBe("hello")
	})

	it("renders each quote as a blockquote followed by its note, then the message", () => {
		const text = formatMessageWithQuotes("Please fix both.", [
			{ text: "first passage", note: "this is wrong" },
			{ text: "second passage", note: "  " },
		])

		expect(text).toBe("> first passage\n\nthis is wrong\n\n> second passage\n\nPlease fix both.")
	})

	it("prefixes every line of a multi-line quote", () => {
		expect(formatMessageWithQuotes("", [{ text: "line one\nline two", note: "" }])).toBe("> line one\n> line two")
	})

	it("attributes a quote to its source and carries only that quoted message", () => {
		const text = formatMessageWithQuotes("Is this still true?", [
			{ text: "Cap exports at 10k rows", note: "", source: "You · Dev plan" },
		])
		expect(text).toBe("> **You · Dev plan**\n> Cap exports at 10k rows\n\nIs this still true?")
	})
})
