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
})
