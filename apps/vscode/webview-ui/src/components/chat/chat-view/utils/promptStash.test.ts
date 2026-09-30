import { describe, expect, it } from "vitest"
import { describeStashEntry, type PromptStashEntry, pushStashEntry, removeStashEntry, takeStashEntry } from "./promptStash"

const entry = (id: string, text: string, quotes: PromptStashEntry["quotes"] = []): PromptStashEntry => ({
	id,
	text,
	quotes,
	ts: 1,
})

describe("prompt stash helpers", () => {
	it("adds a non-empty draft as the newest entry", () => {
		const next = pushStashEntry([entry("a", "older")], { text: "draft", quotes: [] }, { id: "b", ts: 5, taskId: "t1" })

		expect(next.map((e) => e.id)).toEqual(["b", "a"])
		expect(next[0]).toEqual({ id: "b", text: "draft", quotes: [], ts: 5, taskId: "t1" })
	})

	it("ignores an empty draft", () => {
		const entries = [entry("a", "older")]
		expect(pushStashEntry(entries, { text: "   ", quotes: [] }, { id: "b", ts: 5 })).toBe(entries)
	})

	it("stashes a quotes-only draft and copies the quotes", () => {
		const quotes = [{ text: "q", note: "n" }]
		const next = pushStashEntry([], { text: "", quotes }, { id: "b", ts: 5 })

		expect(next[0].quotes).toEqual(quotes)
		expect(next[0].quotes[0]).not.toBe(quotes[0])
		expect(describeStashEntry(next[0])).toBe("(1 quote)")
	})

	it("restoring removes the entry", () => {
		const { entries, restored } = takeStashEntry(
			[entry("a", "one"), entry("b", "two")],
			"a",
			{ text: "", quotes: [] },
			{
				id: "c",
				ts: 9,
			},
		)

		expect(restored?.text).toBe("one")
		expect(entries.map((e) => e.id)).toEqual(["b"])
	})

	it("restoring swaps a non-empty current draft into the stash", () => {
		const { entries, restored } = takeStashEntry(
			[entry("a", "one")],
			"a",
			{ text: "current", quotes: [] },
			{
				id: "c",
				ts: 9,
			},
		)

		expect(restored?.id).toBe("a")
		expect(entries).toEqual([{ id: "c", text: "current", quotes: [], ts: 9 }])
	})

	it("returns nothing for an unknown id", () => {
		const entries = [entry("a", "one")]
		expect(takeStashEntry(entries, "zzz", { text: "current", quotes: [] }, { id: "c", ts: 9 })).toEqual({
			entries,
			restored: undefined,
		})
	})

	it("deletes an entry", () => {
		expect(removeStashEntry([entry("a", "one"), entry("b", "two")], "a").map((e) => e.id)).toEqual(["b"])
	})
})
