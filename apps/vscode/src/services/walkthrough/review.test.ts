import { describe, expect, it } from "bun:test"
import { normalizeAuthoredWalkthrough, walkthroughReady } from "./authored"
import { buildPrompt, cacheKey, formatNotes, repairOutput } from "./engine"
import { parseReview, REVIEW_INSTRUCTIONS } from "./review"

const input = {
	title: "Parser",
	chapters: [
		{
			title: "Input",
			stops: [
				{
					title: "Validate input",
					prose: "Validate.",
					hunks: [{ path: "a.ts", patch: "@@ -1 +1,2 @@\n-old\n+new\n+next\n" }],
				},
			],
		},
	],
}
const note = {
	kind: "risk",
	title: "Missing guard",
	text: "The value is used without a guard.",
	stop: "Validate input",
	path: "a.ts",
	lines: "new\nnext",
}
const walk = () => normalizeAuthoredWalkthrough("task", input)

describe("Cline review notes", () => {
	it("validates notes and resolves exact multiline anchors with stable ids", () => {
		const review = parseReview({ notes: [note] }, walk())!
		expect(review.notes[0]).toMatchObject({ stopId: "s1", hunkId: "h1", line: 1, endLine: 2 })
		expect(parseReview({ notes: [note] }, walk())).toEqual(review)
		for (const bad of [
			null,
			{},
			{ notes: [{}] },
			{ notes: [{ ...note, kind: "bug" }] },
			{ notes: [{ ...note, severity: "low" }] },
			{ notes: [{ ...note, title: "" }] },
			{ notes: [{ ...note, lines: 1 }] },
		])
			expect(() => parseReview(bad, walk())).toThrow()
	})
	it("degrades missing text to its stop and missing anchors to the whole change", () => {
		const review = parseReview(
			{
				notes: [
					{ ...note, lines: "missing" },
					{ ...note, title: "Other", stop: "missing", path: "missing" },
				],
			},
			walk(),
		)!
		expect(review.notes[0].stopId).toBe("s1")
		expect(review.notes[0].hunkId).toBeUndefined()
		expect(review.notes[1].stopId).toBeUndefined()
		expect(review.notes[1].hunkId).toBeUndefined()
	})
	it("keeps high notes first, then original order, with stop and total caps", () => {
		const notes = Array.from({ length: 14 }, (_, i) => ({
			...note,
			title: `Note ${i}`,
			...(i === 13 ? { severity: "high" } : {}),
		}))
		expect(parseReview({ notes }, walk())!.notes.map((n) => n.title)).toEqual(["Note 13", "Note 0", "Note 1"])
		const whole = notes.map((n) => ({ ...n, stop: undefined, path: undefined, lines: undefined }))
		expect(parseReview({ notes: whole }, walk())!.notes).toHaveLength(10)
	})
	it("only requests and parses reviews when enabled and uses distinct cache identities", () => {
		const live = walk()
		expect(buildPrompt(live, [])).not.toContain(REVIEW_INSTRUCTIONS)
		expect(buildPrompt(live, [], undefined, true)).toContain("No notes is a valid answer")
		expect(cacheKey(live, {}, [], true)).not.toBe(cacheKey(live, {}, [], false))
		const output = {
			chapters: [{ title: "Input", stops: [{ title: "Validate input", prose: "Validate.", hunkIds: ["h1"] }] }],
			review: { notes: [note] },
		}
		expect(repairOutput(output, live).review).toBeUndefined()
		expect(repairOutput(output, live, true).review?.notes[0]).toMatchObject({ hunkId: "h1", stopId: "s1" })
	})
	it("sends Fix and replies under their host-owned note, excluding dismissed and untouched notes", () => {
		const live = normalizeAuthoredWalkthrough("task", {
			...input,
			review: { notes: [note, { ...note, title: "Dismissed" }, { ...note, title: "Untouched" }] },
		})
		const [first, dismissed] = live.review!.notes
		const message = formatNotes(live, {
			stopNotes: {},
			reviewResponses: {
				[first.id]: { fix: true, reply: "Keep the current API." },
				[dismissed.id]: { dismissed: true, fix: true, reply: "ignore" },
			},
		})
		expect(message).toBe(
			"Review notes for the change walkthrough:\n\n> Stop: Validate input\n> Cline's risk: Missing guard\n> a.ts:1-2\n> The value is used without a guard.\n\nPlease fix this.\n\nReply: Keep the current API.",
		)
		expect(() =>
			formatNotes(live, { stopNotes: {}, reviewResponses: { [first.id]: { dismissed: true, fix: true } } }),
		).toThrow("Add a note")
		expect(formatNotes(live, { stopNotes: {}, reviewResponses: { [first.id]: { reply: "Why?" } } })).not.toContain(
			"Please fix",
		)
	})
	it("includes counts in the ready payload only for documents with review", () => {
		expect(walkthroughReady(walk()).reviewCount).toBeUndefined()
		const live = normalizeAuthoredWalkthrough("task", {
			...input,
			review: {
				notes: [
					{ ...note, severity: "high" },
					{ ...note, title: "Good", kind: "nice" },
				],
			},
		})
		expect(walkthroughReady(live)).toMatchObject({ reviewCount: 2, reviewHighCount: 1 })
	})
})
