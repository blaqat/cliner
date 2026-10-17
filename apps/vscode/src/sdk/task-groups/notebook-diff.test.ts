import { describe, expect, it } from "vitest"
import { notebookDiff } from "./notebook-diff"

describe("notebookDiff", () => {
	it("keeps two context lines and retains collapsed text at both ends", () => {
		const before = `${Array.from({ length: 15 }, (_, i) => `line ${i}`).join("\n")}\n`
		const lines = notebookDiff(before, before.replace("line 7", "changed"))
		expect(lines).toEqual([
			{ kind: "collapsed", text: "line 0\nline 1\nline 2\nline 3\nline 4" },
			{ kind: "context", text: "line 5" },
			{ kind: "context", text: "line 6" },
			{ kind: "remove", text: "line 7" },
			{ kind: "add", text: "changed" },
			{ kind: "context", text: "line 8" },
			{ kind: "context", text: "line 9" },
			{ kind: "collapsed", text: "line 10\nline 11\nline 12\nline 13\nline 14" },
		])
	})
	it("handles creation, deletion and empty notes", () => {
		expect(notebookDiff("", "new\n")).toEqual([{ kind: "add", text: "new" }])
		expect(notebookDiff("old\n", "")).toEqual([{ kind: "remove", text: "old" }])
		expect(notebookDiff("", "")).toEqual([])
	})
	it("merges nearby context without duplicate lines", () => {
		const diff = notebookDiff("a\nb\nc\nd\ne\nf\n", "a\nB\nc\nd\nE\nf\n")
		expect(diff.filter((line) => line.kind === "collapsed")).toEqual([])
		expect(diff.filter((line) => line.text === "c")).toHaveLength(1)
	})
})
