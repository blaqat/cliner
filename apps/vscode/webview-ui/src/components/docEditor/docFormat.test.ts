import { describe, expect, it } from "vitest"
import { applyFormat, continueList, prefixLines, wrapSelection } from "./docFormat"
import { addedLineNumbers, changedSection, diffCounts, noteBlocks, noteSections } from "./noteBlocks"

describe("doc format bar", () => {
	it("wraps the selection, or a selected placeholder, and unwraps when already wrapped", () => {
		expect(wrapSelection("a word b", 2, 6, "**")).toEqual({ text: "a **word** b", start: 4, end: 8 })
		expect(wrapSelection("ab", 1, 1, "`", "`", "code")).toEqual({ text: "a`code`b", start: 2, end: 6 })
		expect(wrapSelection("a **word** b", 4, 8, "**")).toEqual({ text: "a word b", start: 2, end: 6 })
	})

	it("prefixes every selected line and toggles the prefix off", () => {
		const bulleted = prefixLines("one\ntwo\nthree", 0, 7, "- ")
		expect(bulleted.text).toBe("- one\n- two\nthree")
		expect(prefixLines(bulleted.text, 0, 11, "- ").text).toBe("one\ntwo\nthree")
		expect(prefixLines("a\nb", 0, 3, "1. ").text).toBe("1. a\n2. b")
	})

	it("selects the url placeholder after linking selected text", () => {
		const edit = applyFormat("link", "see docs", 4, 8)
		expect(edit.text).toBe("see [docs](url)")
		expect(edit.text.slice(edit.start, edit.end)).toBe("url")
	})

	it("continues a list on Enter and ends it on an empty item", () => {
		expect(continueList("- one", 5)?.text).toBe("- one\n- ")
		expect(continueList("3. three", 8)?.text).toBe("3. three\n4. ")
		expect(continueList("- [x] done", 10)?.text).toBe("- [x] done\n- [ ] ")
		expect(continueList("- one\n- ", 8)).toEqual({ text: "- one\n", start: 6, end: 6 })
		expect(continueList("plain", 5)).toBeUndefined()
	})
})

describe("marked note", () => {
	const content = "# Flow\nLogin.\n\n## Gotchas\n- old\n- new line"
	const diff = [
		{ kind: "collapsed" as const, text: "# Flow\nLogin.\n\n## Gotchas" },
		{ kind: "context" as const, text: "- old" },
		{ kind: "remove" as const, text: "- gone" },
		{ kind: "add" as const, text: "- new line" },
	]

	it("maps the diff's added lines onto the new text", () => {
		expect([...addedLineNumbers(diff)]).toEqual([5])
		expect(diffCounts(diff)).toEqual({ added: 1, removed: 1 })
		expect(changedSection(content, diff)).toBe("Gotchas")
	})

	it("marks only the list item that was added, under its section", () => {
		const blocks = noteBlocks(content, addedLineNumbers(diff))
		expect(blocks.filter((block) => block.marked).map((block) => block.raw)).toEqual(["- new line"])
		const sections = noteSections(blocks)
		expect(sections.map((section) => [section.heading, section.marked])).toEqual([
			["Flow", false],
			["Gotchas", true],
		])
	})
})
