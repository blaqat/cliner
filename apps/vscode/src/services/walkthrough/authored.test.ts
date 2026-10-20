import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { AgentRuntime } from "@cline/agents"
import type { AgentModel, AgentModelEvent, AgentToolContext } from "@cline/shared"
import type { AuthoredWalkthroughInput } from "@shared/Walkthrough"

let directory = ""
mock.module("@/core/storage/disk", () => ({ ensureTaskDirectoryExists: async () => directory }))
const { normalizeAuthoredWalkthrough, parseAuthoredPatch, readAuthoredWalkthrough, saveAuthoredWalkthrough, walkthroughReady } =
	await import("./authored")
const { createPresentWalkthroughTool } = await import("./authored-tool")
const patch = "@@ -1 +1 @@\n-old\n+new\n"
const input = (): AuthoredWalkthroughInput => ({
	title: "Review parser",
	origin: { label: "MR !12", url: "https://example.com/mr/12" },
	chapters: [
		{
			title: "Parser",
			stops: [{ title: "Validate the input", prose: "Reject invalid input.", hunks: [{ path: "src/a.ts", patch }] }],
		},
	],
})
beforeEach(async () => {
	directory = await mkdtemp(path.join(tmpdir(), "authored-walkthrough-"))
})
afterEach(async () => {
	await rm(directory, { recursive: true, force: true })
})
describe("authored walkthroughs", () => {
	it("normalizes single hunks with stable file ids and content fingerprints", () => {
		const walk = normalizeAuthoredWalkthrough("task", input())
		expect(walk).toMatchObject({
			scope: "authored",
			source: "authored",
			chapters: [{ id: "c1", stops: [{ id: "s1", hunkIds: ["h1"] }] }],
		})
		expect(walk.hunks[0]).toMatchObject({ id: "h1", external: true, oldStart: 1, newStart: 1, patch })
		expect(normalizeAuthoredWalkthrough("task", input()).fingerprint).toBe(walk.fingerprint)
		const changed = input()
		changed.chapters[0].stops[0].prose = "Changed prose."
		expect(normalizeAuthoredWalkthrough("task", changed).fingerprint).not.toBe(walk.fingerprint)
	})
	it("splits full file diffs with multiple hunks", () => {
		const value = input()
		value.chapters[0].stops[0].hunks[0].patch = `diff --git a/src/a.ts b/src/a.ts\nindex 123..456 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n${patch}@@ -8,0 +9,1 @@ label\n+added\n`
		const walk = normalizeAuthoredWalkthrough("task", value)
		expect(walk.chapters[0].stops[0].hunkIds).toEqual(["h1", "h2"])
		expect(walk.hunks[1]).toMatchObject({ oldStart: 8, newStart: 9, header: "@@ -8,0 +9,1 @@ label" })
		expect(walk.hunks[0].fileId).toBe(walk.hunks[1].fileId)
	})
	it("allows narrative stops", () => {
		const value = input()
		value.chapters[0].stops[0].hunks = []
		expect(walkthroughReady(normalizeAuthoredWalkthrough("task", value))).toMatchObject({ stopCount: 1, fileCount: 0 })
	})
	it("rejects malformed patches with actionable errors", () => {
		for (const bad of [
			"not a patch",
			"--- a\n+++ b\n",
			"@@ broken\n",
			"@@ -1 +1 @@\n",
			"@@ -1 +1 @@\n-old\nnot a diff line\n",
			`${patch}diff --git a/b b/b\n`,
		])
			expect(() => parseAuthoredPatch(bad)).toThrow("Malformed patch")
	})
	it("repairs hunk headers whose counts do not match the body", () => {
		// The QA repro: header says +1,11 but the body has 12 new-side lines.
		const body = `${Array.from({ length: 7 }, (_, n) => ` ctx${n}`).join("\n")}\n${Array.from({ length: 5 }, (_, n) => `+added${n}`).join("\n")}\n`
		const value = input()
		value.chapters[0].stops[0].hunks[0].patch = `@@ -1,7 +1,11 @@ function f() {\n${body}`
		const walk = normalizeAuthoredWalkthrough("task", value)
		expect(walk.hunks).toHaveLength(1)
		expect(walk.hunks[0]).toMatchObject({
			header: "@@ -1,7 +1,12 @@ function f() {",
			oldStart: 1,
			newStart: 1,
			patch: `@@ -1,7 +1,12 @@ function f() {\n${body}`,
		})
		expect(walk.warnings).toEqual([
			"Repaired hunk header in src/a.ts: @@ -1,7 +1,11 @@ function f() { -> @@ -1,7 +1,12 @@ function f() {",
		])
	})
	it("repairs missing or garbled starts and blank context lines, and leaves valid headers untouched", () => {
		const [garbled] = parseAuthoredPatch("@@ -x +7,2 @@ label\n a\n\n-b\n+c\n")
		expect(garbled).toMatchObject({
			oldStart: 7,
			newStart: 7,
			header: "@@ -7,3 +7,3 @@ label",
			patch: "@@ -7,3 +7,3 @@ label\n a\n \n-b\n+c\n",
		})
		expect(garbled.warning).toContain("->")
		const [bare] = parseAuthoredPatch("@@ @@\n+only\n")
		expect(bare).toMatchObject({ oldStart: 1, newStart: 1, header: "@@ -1,0 +1 @@" })
		const [fine] = parseAuthoredPatch(patch)
		expect(fine.warning).toBeUndefined()
		expect(normalizeAuthoredWalkthrough("task", input()).warnings).toEqual([])
	})
	it("enforces chapter, stop, hunk and patch caps", () => {
		const value = input()
		expect(() => normalizeAuthoredWalkthrough("task", { ...value, chapters: Array(9).fill(value.chapters[0]) })).toThrow(
			"1–8 chapters",
		)
		value.chapters[0].stops = Array(61).fill(value.chapters[0].stops[0])
		expect(() => normalizeAuthoredWalkthrough("task", value)).toThrow("60 stops")
		const many = input()
		many.chapters[0].stops[0].hunks[0].patch = patch.repeat(401)
		expect(() => normalizeAuthoredWalkthrough("task", many)).toThrow("400 hunks")
		many.chapters[0].stops[0].hunks[0].patch = "+".repeat(300001)
		expect(() => normalizeAuthoredWalkthrough("task", many)).toThrow("300000")
		const total = input()
		total.chapters[0].stops[0].hunks = Array(2).fill({ path: "a", patch: `@@ -0,0 +1 @@\n+${"x".repeat(160000)}\n` })
		expect(() => normalizeAuthoredWalkthrough("task", total)).toThrow("300000 total")
	})
	it("validates input shape and origin links", () => {
		for (const value of [
			null,
			{},
			{ ...input(), chapters: [] },
			{ ...input(), origin: { label: "bad", url: "javascript:alert(1)" } },
		])
			expect(() => normalizeAuthoredWalkthrough("task", value)).toThrow()
	})
	it("round trips separate presentations and refuses traversal", async () => {
		const first = await saveAuthoredWalkthrough("task", input())
		const second = await saveAuthoredWalkthrough("task", input())
		expect(second.authoredId).not.toBe(first.authoredId)
		expect(await readAuthoredWalkthrough("task", first.authoredId)).toEqual(first)
		await expect(readAuthoredWalkthrough("task", "../settings")).rejects.toThrow("authoredId")
		await expect(readAuthoredWalkthrough("another", first.authoredId)).rejects.toThrow("Invalid stored")
	})
	it("tool stores the document and returns the card payload", async () => {
		const tool = createPresentWalkthroughTool()
		expect(tool.metadata?.subagentAccess).toBeUndefined()
		expect(tool.lifecycle?.emptyResponseCompletes).toBe(true)
		const result = JSON.parse(await tool.execute(input(), { sessionId: "task" } as AgentToolContext))
		const walk = await readAuthoredWalkthrough("task", result.walkthroughReady.authoredId)
		expect(result.walkthroughReady).toEqual(walkthroughReady(walk))
		expect(result.message).toContain("shown to the user")
		expect(result.message).toContain("one short sentence")
		await expect(tool.execute(input(), { sessionId: "../escape" } as AgentToolContext)).rejects.toThrow("thread session")
	})
	it("ends the turn as completed when the model returns nothing after a successful present_walkthrough", async () => {
		const steps: AgentModelEvent[][] = [
			[
				{
					type: "tool-call-delta",
					toolCallId: "call_1",
					toolName: "present_walkthrough",
					inputText: JSON.stringify(input()),
				},
				{ type: "finish", reason: "tool-calls" },
			],
			[{ type: "finish", reason: "stop" }],
		]
		const model: AgentModel = {
			stream: async () =>
				(async function* () {
					yield* steps.shift() ?? []
				})(),
		}
		const runtime = new AgentRuntime({ model, tools: [createPresentWalkthroughTool()], sessionId: "task" } as never)
		const result = await runtime.run("Review the MR")
		expect(result.error).toBeUndefined()
		expect(result.status).toBe("completed")
		expect(steps).toHaveLength(0)
	})
})
