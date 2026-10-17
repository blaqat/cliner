import type { ChangeWalkthrough } from "@shared/Walkthrough"
import { describe, expect, it } from "vitest"
import {
	carryOverReview,
	discardUnplacedNotes,
	dropStale,
	hasContent,
	migrateRegeneratedReview,
	notesToSend,
	previousLayoutKey,
	type ReviewStore,
	recoverUnplacedNotes,
	summarizeStale,
	unplacedNotes,
} from "./reviewState"
import { patchToDiffLines, splitInlineCode, supportSummary } from "./walkthroughUtils"

const walk = (fingerprint: string, stops: [string, string][], source: ChangeWalkthrough["source"] = "fallback") =>
	({
		version: 1,
		taskId: "t",
		scope: "thread",
		fingerprint,
		source,
		title: "",
		focus: "",
		chapters: [{ id: "c1", title: "Turn 1", stops: stops.map(([id, title]) => ({ id, title, prose: "", hunkIds: [] })) }],
		support: [],
		hunks: [],
		warnings: [],
	}) as ChangeWalkthrough

describe("review state", () => {
	it("counts only real content and summarizes other fingerprints as stale", () => {
		expect(hasContent({ fallback: { notes: { s1: "  " }, reviewed: { s1: false } } })).toBe(false)
		const store: ReviewStore = {
			old: { overallNote: "All good", fallback: { notes: { s1: "x", s2: "" }, reviewed: { s1: true, s2: true } } },
			now: { fallback: { notes: { s1: "y" }, reviewed: {} } },
		}
		expect(summarizeStale(store, "now")).toEqual({ notes: 2, reviewed: 2 })
		expect(dropStale(store, "now")).toEqual({ now: store.now })
		expect(dropStale(store, "missing")).toEqual({})
	})

	it("sends only this document's non-empty notes, trimmed", () => {
		const doc = walk("f", [["s1", "A"]])
		expect(notesToSend(doc, { notes: { s1: " keep ", s9: "gone", s2: " " }, reviewed: {} }, "  ")).toEqual({
			stopNotes: { s1: "keep" },
			overallNote: undefined,
			count: 1,
		})
	})

	it("moves notes to same-titled stops after a revert, and keeps unplaceable notes as stale", () => {
		const before = walk("f1", [
			["s1", "Keep"],
			["s2", "Gone"],
		])
		const placed = carryOverReview(
			{ f1: { overallNote: "o", fallback: { notes: { s1: "n1" }, reviewed: { s1: true, s2: true } } } },
			before,
			walk("f2", [["s7", "Keep"]]),
		)
		expect(placed).toEqual({ f2: { overallNote: "o", fallback: { notes: { s7: "n1" }, reviewed: { s7: true } } } })

		const lost = carryOverReview(
			{ f1: { overallNote: "o", fallback: { notes: { s2: "lost" }, reviewed: {} } } },
			before,
			walk("f2", [["s1", "Keep"]]),
		)
		expect(lost.f2).toEqual({ overallNote: "o", fallback: { notes: {}, reviewed: {} } })
		expect(lost.f1).toEqual({ overallNote: undefined, fallback: { notes: { s2: "lost" }, reviewed: {} } })
	})
})

describe("regenerated layouts", () => {
	const layout = (stops: [string, string, string[]][]) =>
		({
			...walk("f", [], "generated"),
			chapters: [{ id: "c", title: "C", stops: stops.map(([id, title, hunkIds]) => ({ id, title, prose: "", hunkIds })) }],
		}) as ChangeWalkthrough
	const before = layout([
		["s1", "Parser", ["h1", "h2"]],
		["s2", "Cache", ["h3"]],
		["s3", "Docs", ["h4"]],
		["s4", "Lost", ["h9"]],
	])

	it("moves notes by hunk set, then title, then containing stop, and keeps the rest as unplaced", () => {
		const after = layout([
			["n1", "Input checks", ["h1", "h2"]],
			["n2", "Cache", ["h7"]],
			["n3", "Everything else", ["h4", "h5"]],
		])
		const store: ReviewStore = {
			f: {
				generated: {
					notes: { s1: "a", s2: "b", s3: "c", s4: "d" },
					reviewed: { s1: true, s3: true },
				},
			},
		}
		const next = migrateRegeneratedReview(store, before, after)
		expect(next.f.generated).toEqual({ notes: { n1: "a", n2: "b", n3: "c" }, reviewed: { n1: true } })
		expect(unplacedNotes(next, "f")).toEqual(["Lost: d"])
		expect(summarizeStale(next, "f")).toEqual({ notes: 0, reviewed: 0 })
	})

	it("keeps unplaced notes through Refresh until recovered or discarded", () => {
		const store: ReviewStore = { f: { generated: { notes: { s4: "d" }, reviewed: {} } } }
		const next = migrateRegeneratedReview(store, before, layout([["n1", "New", ["h1"]]]))
		expect(dropStale(next, "f")[previousLayoutKey("f")]).toBeDefined()
		expect(discardUnplacedNotes(next, "f")[previousLayoutKey("f")]).toBeUndefined()
		expect(recoverUnplacedNotes(next, "f").f.overallNote).toBe("Lost: d")
		expect(recoverUnplacedNotes(next, "f")[previousLayoutKey("f")]).toBeUndefined()
	})

	it("leaves the store alone when the layout is not generated or the changes moved", () => {
		const store: ReviewStore = { f: { generated: { notes: { s1: "a" }, reviewed: {} } } }
		expect(migrateRegeneratedReview(store, { ...before, fingerprint: "other" }, before)).toBe(store)
		expect(migrateRegeneratedReview(store, { ...before, source: "fallback" }, before)).toBe(store)
	})
})

describe("walkthrough utils", () => {
	it("turns a unified patch into grouped diff lines without headers", () => {
		expect(patchToDiffLines("@@ -1,3 +1,3 @@\n a\n-b\n-c\n+d\n\\ No newline at end of file\n")).toEqual([
			{ kind: "context", text: "a" },
			{ kind: "remove", text: "b\nc" },
			{ kind: "add", text: "d" },
		])
	})

	it("splits prose into text and inline code", () => {
		expect(splitInlineCode("Use `x` here")).toEqual([
			{ code: false, text: "Use " },
			{ code: true, text: "x" },
			{ code: false, text: " here" },
		])
	})

	it("summarizes support file names", () => {
		const doc = walk("f", [])
		doc.support = [{ id: "support", title: "", prose: "", hunkIds: ["h1", "h2"] }]
		doc.hunks = ["bun.lock", "a/README.md"].map((path, i) => ({
			id: `h${i + 1}`,
			fingerprint: "",
			fileId: path,
			path,
			header: "",
			patch: "",
			oldStart: 0,
			newStart: 0,
		}))
		expect(supportSummary(doc)).toBe("bun.lock, README.md")
	})
})
