import { describe, expect, it } from "bun:test"
import type { ApiHandler, ApiStreamChunk } from "@cline/llms"
import {
	buildPrompt,
	type ContentChange,
	cacheKey,
	ceilings,
	collectHunks,
	type EditTurn,
	excerpt,
	fallback,
	formatNotes,
	generate,
	repairOutput,
	timeoutMs,
} from "./engine"

const change = (path = "a.ts", turnId = "turn1", after = "new\n"): ContentChange => ({
	filePath: `/workspace/${path}`,
	path,
	before: "old\n",
	after,
	beforeExists: true,
	afterExists: true,
	turnId,
})
const turns: EditTurn[] = [
	{ id: "turn1", prose: "Changed the parser.", context: "Fix parsing", changes: [change()] },
	{ id: "turn2", prose: "Added validation.", context: "Validate", changes: [change("b.ts", "turn2")] },
]
const live = () =>
	fallback(
		"task",
		"thread",
		turns,
		turns.flatMap((t) => t.changes),
	)
const output = {
	title: "Parse safely",
	focus: "Reject invalid input.",
	chapters: [
		{ title: "Parser", stops: [{ title: "Reject invalid input", prose: "The parser validates input.", hunkIds: ["h1"] }] },
	],
	support: [],
}

describe("walkthrough engine", () => {
	it("assigns deterministic aliases, fingerprints and exact git hunks independent of file ordering", () => {
		const a = collectHunks([change("z.ts"), change("a.ts")])
		const b = collectHunks([change("a.ts"), change("z.ts")])
		expect(a).toEqual(b)
		expect(a.map((h) => h.id)).toEqual(["h1", "h2"])
		expect(a[0].patch).toContain("-old\n+new")
		expect(collectHunks([change("a.ts", "turn1", "different\n")])[0].fingerprint).not.toBe(a[0].fingerprint)
	})
	it("preserves fallback turn grouping and agent prose without calling a model", () => {
		const walk = live()
		expect(walk.source).toBe("fallback")
		expect(walk.chapters).toHaveLength(2)
		expect(walk.chapters[0].stops[0].prose).toBe("Changed the parser.")
		expect(walk.chapters[1].stops[0].hunkIds).toEqual(["h2"])
	})
	it("uses one fallback stop per file for git scope", () => {
		const walk = fallback("task", "git", [], [change(), change("b.ts")])
		expect(walk.chapters.flatMap((c) => c.stops).map((s) => s.title)).toEqual(["a.ts", "b.ts"])
	})
	it("groups git hunks with turn evidence and keeps unrelated files in their own stops", () => {
		const walk = fallback("task", "git", turns, [change(), { ...change("manual.ts"), turnId: undefined }])
		const stops = walk.chapters.flatMap((chapter) => chapter.stops)
		expect(stops[0].prose).toBe("Changed the parser.")
		expect(stops[0].turnId).toBe("turn1")
		expect(stops[1].title).toBe("manual.ts")
		expect(stops.flatMap((stop) => stop.hunkIds)).toHaveLength(2)
	})
	it("keeps synthetic binary hunks in the fallback layout", () => {
		const binary = change("image.bin", "turn1", "new\0binary")
		const turn = { ...turns[0], changes: [binary] }
		const walk = fallback("task", "thread", [turn], [{ ...binary, turnId: undefined }])
		expect(walk.hunks[0].synthetic).toBe(true)
		expect(walk.chapters[0].stops[0].hunkIds).toEqual(["h1"])
	})
	it("bounds excerpts, shares the total budget fairly, and marks truncation", () => {
		expect(excerpt("abcdef", 4)).toBe("abc…")
		expect(excerpt("abc", 0)).toBe("")
		for (const fileCount of [2, 12, 40]) {
			const walk = live()
			walk.hunks = Array.from({ length: fileCount * 3 }, (_, i) => ({
				...walk.hunks[0],
				id: `h${i + 1}`,
				path: `file${i % fileCount}.ts`,
				patch: "x".repeat(16000),
			}))
			const digest = JSON.parse(buildPrompt(walk, turns))
			const limits = ceilings(walk.hunks)
			expect(digest.hunks.reduce((sum: number, h: { patch: string }) => sum + h.patch.length, 0)).toBeLessThanOrEqual(
				limits.total,
			)
			expect(digest.hunks.every((h: { patch: string }) => h.patch.length <= limits.perHunk && h.patch.endsWith("…"))).toBe(
				true,
			)
		}
	})
	it("drops unknown and duplicate aliases and puts every omission in support exactly once", () => {
		const result = repairOutput(
			{
				...output,
				chapters: [
					{
						title: "A title over sixteen characters",
						stops: [
							{ title: "Main change", prose: "Text", hunkIds: ["h1", "unknown", "h1"] },
							{ title: "Duplicate", hunkIds: ["h1"] },
						],
					},
				],
				support: ["bad", "h2", "h2", "h1"],
			},
			live(),
		)
		expect(result.chapters[0].title.length).toBeLessThanOrEqual(16)
		expect(result.chapters[0].stops).toHaveLength(1)
		expect(result.chapters[0].stops[0].hunkIds).toEqual(["h1"])
		expect(result.support[0].hunkIds).toEqual(["h2"])
		expect(repairOutput(output, live()).support[0].hunkIds).toEqual(["h2"])
	})
	it("enforces size ceilings and fourteen aliases per stop", () => {
		const walk = live()
		walk.hunks = Array.from({ length: 30 }, (_, i) => ({ ...walk.hunks[0], id: `h${i + 1}`, path: `file${i}.ts` }))
		const repaired = repairOutput(
			{
				...output,
				chapters: [{ title: "Changes", stops: [{ title: "Main change", hunkIds: walk.hunks.map((h) => h.id) }] }],
			},
			walk,
		)
		expect(repaired.chapters[0].stops[0].hunkIds).toHaveLength(14)
		expect(repaired.support[0].hunkIds).toHaveLength(16)
		expect(ceilings(live().hunks).stops).toBe(2)
	})
	it("changes cache identity with diff, model, context and model options", () => {
		const a = cacheKey(live(), { model: "a" }, turns)
		expect(cacheKey(live(), { model: "a" }, turns)).toBe(a)
		expect(cacheKey(live(), { model: "b" }, turns)).not.toBe(a)
		expect(cacheKey({ ...live(), scope: "last_turn" }, { model: "a" }, turns)).not.toBe(a)
		expect(cacheKey(live(), { model: "a", effort: "high" }, turns)).not.toBe(a)
		expect(cacheKey(live(), { model: "a" }, [{ ...turns[0], context: "Changed intent" }])).not.toBe(a)
		const altered = live()
		altered.hunks[0].fingerprint = "changed"
		expect(cacheKey(altered, { model: "a" }, turns)).not.toBe(a)
	})
	it("regenerates with previous prose but no IDs or anchors", () => {
		const prior = live()
		prior.chapters[0].stops[0].id = "old-stop-unique"
		const prompt = JSON.parse(buildPrompt(live(), turns, prior))
		expect(JSON.stringify(prompt.previous)).not.toMatch(/hunkIds|fileId|turnId|old-stop-unique/)
		expect(prompt.previous.chapters[0].stops[0].prose).toBe("Changed the parser.")
	})
	it("quotes stop title, path and bounded hunks before its note, then the overall note", () => {
		const message = formatNotes(live(), { stopNotes: { s1: "Why this?" }, overallNote: "Add tests." })
		expect(message).toContain("> Stop: Turn 1")
		expect(message).toContain("> a.ts")
		expect(message).toContain("> -old\n> +new")
		expect(message.indexOf("Why this?")).toBeGreaterThan(message.indexOf("> +new"))
		expect(message).toEndWith("Overall note:\nAdd tests.")
		expect(() => formatNotes(live(), { stopNotes: {} })).toThrow("Add a note")
	})
	it("makes a single mocked streaming request and repairs its structured tool output", async () => {
		let requests = 0
		const handler = {
			async *createMessage(...[_system, _messages, tools]: Parameters<ApiHandler["createMessage"]>) {
				requests++
				expect(tools?.[0].name).toBe("submit_walkthrough")
				const args = JSON.stringify(output)
				yield {
					type: "tool_calls",
					id: "response",
					tool_call: { call_id: "call", function: { name: "submit_walkthrough", arguments: args.slice(0, 40) } },
				}
				yield {
					type: "tool_calls",
					id: "response",
					tool_call: { call_id: "call", function: { arguments: args.slice(40) } },
				}
			},
		} as unknown as ApiHandler
		const result = await generate(live(), turns, handler)
		expect(requests).toBe(1)
		expect(result.source).toBe("generated")
		expect(result.support[0].hunkIds).toEqual(["h2"])
	})
	it("rejects absent or extra tool submissions without another request", async () => {
		for (const chunks of [
			[],
			[{ type: "text", id: "r", text: "not a submission" }],
			...["first", "second"].map(() =>
				["a", "b"].map((id) => ({
					type: "tool_calls",
					id: "r",
					tool_call: { call_id: id, function: { name: "submit_walkthrough", arguments: output } },
				})),
			),
		]) {
			const handler = {
				async *createMessage() {
					for (const chunk of chunks) yield chunk as ApiStreamChunk
				},
			} as unknown as ApiHandler
			await expect(generate(live(), turns, handler)).rejects.toThrow("exactly one")
		}
	})
	it("scales the timeout and caps it at five minutes", () => {
		const walk = live()
		expect(timeoutMs(walk)).toBe(90000)
		walk.hunks = Array.from({ length: 1000 }, (_, i) => ({ ...walk.hunks[0], path: `${i}` }))
		expect(timeoutMs(walk)).toBe(300000)
	})
})
