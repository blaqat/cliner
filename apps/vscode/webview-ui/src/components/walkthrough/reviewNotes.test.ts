import type { ChangeWalkthrough, WalkthroughReviewNote } from "@shared/Walkthrough"
import { describe, expect, it } from "vitest"
import {
	describeKinds,
	groupReviewNotes,
	placeReviewNotes,
	responseToSend,
	reviewLineLabel,
	sortReviewNotes,
	splitGroup,
} from "./reviewNotes"
import { carryOverReview, hasContent, migrateRegeneratedReview, notesToSend, previousLayoutKey } from "./reviewState"

const note = (id: string, extra: Partial<WalkthroughReviewNote> = {}): WalkthroughReviewNote => ({
	id,
	kind: "suggestion",
	title: `Note ${id}`,
	text: "text",
	...extra,
})

const doc = (notes: WalkthroughReviewNote[], extra: Partial<ChangeWalkthrough> = {}): ChangeWalkthrough => ({
	version: 1,
	taskId: "t",
	scope: "thread",
	fingerprint: "f",
	source: "generated",
	title: "",
	focus: "",
	chapters: [
		{
			id: "c1",
			title: "One",
			stops: [
				{ id: "s1", title: "First", prose: "", hunkIds: ["h1"] },
				{ id: "s2", title: "Second", prose: "", hunkIds: [] },
			],
		},
	],
	support: [],
	hunks: [
		{
			id: "h1",
			fingerprint: "fp1",
			fileId: "a",
			path: "a.ts",
			header: "@@ -10,2 +10,3 @@",
			patch: "@@ -10,2 +10,3 @@\n keep\n-old\n+new\n+more\n",
			oldStart: 10,
			newStart: 10,
		},
	],
	warnings: [],
	review: { notes },
	...extra,
})

describe("placing Cline's notes", () => {
	it("keeps real lines, finds a line note's stop from its hunk, and falls back when a line is missing", () => {
		const walk = doc([
			note("whole"),
			note("stop", { stopId: "s2" }),
			note("lines", { hunkId: "h1", line: 2, endLine: 3 }),
			note("past-end", { stopId: "s1", hunkId: "h1", line: 9 }),
			note("no-hunk", { hunkId: "gone", line: 0 }),
			note("no-stop", { stopId: "s9" }),
		])
		const placed = Object.fromEntries(placeReviewNotes(walk).map((p) => [p.note.id, p]))
		expect(placed.whole).toEqual({ note: walk.review?.notes[0], stopId: undefined, lineLost: undefined })
		expect(placed.stop.stopId).toBe("s2")
		expect(placed.lines).toMatchObject({ stopId: "s1", hunkId: "h1", line: 2, endLine: 3 })
		expect(placed["past-end"]).toMatchObject({ stopId: "s1", lineLost: true })
		expect(placed["past-end"].hunkId).toBeUndefined()
		expect(placed["no-hunk"]).toMatchObject({ stopId: undefined, lineLost: true })
		expect(placed["no-stop"]).toMatchObject({ stopId: undefined, lineLost: true })
		expect(reviewLineLabel(walk, placed.lines)).toBe("lines 11–12")
	})

	it("groups whole-change notes first, then stops in page order, high severity first", () => {
		const walk = doc([
			note("b", { stopId: "s2" }),
			note("a", { stopId: "s1", kind: "question" }),
			note("hi", { stopId: "s1", kind: "suggestion", severity: "high" }),
			note("w"),
		])
		const groups = groupReviewNotes(walk, placeReviewNotes(walk))
		expect(groups.map((g) => g.key)).toEqual(["whole", "s1", "s2"])
		expect(groups[1].notes.map((p) => p.note.id)).toEqual(["hi", "a"])
		expect(groups[1].number).toBe(1)
	})

	it("caps a group at three, keeps nice notes out of the top, and names what's behind +N more", () => {
		const walk = doc([
			note("n", { stopId: "s1", kind: "nice" }),
			note("s1", { stopId: "s1" }),
			note("s2", { stopId: "s1" }),
			note("q", { stopId: "s1", kind: "question" }),
			note("r", { stopId: "s1", kind: "risk" }),
			note("h", { stopId: "s1", severity: "high" }),
		])
		const { top, more, nice } = splitGroup(sortReviewNotes(placeReviewNotes(walk)))
		expect(top.map((p) => p.note.id)).toEqual(["h", "r", "q"])
		expect(more.map((p) => p.note.id)).toEqual(["s1", "s2"])
		expect(nice.map((p) => p.note.id)).toEqual(["n"])
		expect(describeKinds(more)).toBe("2 suggestions")
	})
})

describe("answers to Cline's notes", () => {
	it("sends fixes and replies, never dismissed or untouched notes", () => {
		expect(responseToSend({ fix: true, dismissed: true })).toBeUndefined()
		expect(responseToSend({ reply: "  " })).toBeUndefined()
		expect(responseToSend({ fix: true, reply: " ok " })).toEqual({ fix: true, reply: "ok" })
		const walk = doc([note("a"), note("b"), note("c"), note("d")])
		const sending = notesToSend(
			walk,
			{ notes: {}, reviewed: {} },
			undefined,
			{},
			{
				a: { fix: true },
				b: { reply: "why?" },
				c: { dismissed: true, fix: true },
				gone: { fix: true },
			},
		)
		expect(sending.reviewResponses).toEqual({ a: { fix: true }, b: { reply: "why?" } })
		expect(sending).toMatchObject({ notes: 0, fixes: 1, replies: 1, count: 2 })
	})

	it("keeps dismissals, and keeps a reply a regenerate can't place in the banner", () => {
		expect(hasContent({ reviewResponses: { a: { dismissed: true } } })).toBe(true)
		const before = doc([note("a", { title: "Retry 4xx" })])
		const after = doc([note("a", { title: "Something else" })])
		const store = { f: { reviewResponses: { a: { fix: true, reply: "only 5xx" } } } }
		const next = migrateRegeneratedReview(store, before, after)
		expect(next.f.reviewResponses).toBeUndefined()
		expect(Object.values(next[previousLayoutKey("f")]?.generated?.notes ?? {})).toEqual([
			'Reply to Cline\'s "Retry 4xx": only 5xx',
		])
	})

	it("carries answers over a revert when the same note is still there", () => {
		const before = doc([note("a"), note("b")])
		const after = { ...doc([note("a")]), fingerprint: "g" }
		const next = carryOverReview({ f: { reviewResponses: { a: { fix: true }, b: { reply: "hm" } } } }, before, after)
		expect(next.g.reviewResponses).toEqual({ a: { fix: true } })
		// b's reply had nowhere to go: the old record stays for the "Changes moved" banner.
		expect(next.f.reviewResponses).toEqual({ b: { reply: "hm" } })
	})
})
