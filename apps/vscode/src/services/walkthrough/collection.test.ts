import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { Message } from "@cline/shared"
import { changesBetween, collect, git, modulePath, readEdits, recordEdits, revertChange, transcriptTurns } from "./collection"
import { type ContentChange, fallback } from "./engine"
import { recordToolEdits } from "./recording"

setDefaultTimeout(30000)
let directory = ""
async function repo(name: string): Promise<string> {
	const root = path.join(directory, name)
	await mkdir(root, { recursive: true })
	await git(root, ["init", "-q"])
	await git(root, ["config", "user.name", "Walkthrough test"])
	await git(root, ["config", "user.email", "test@example.invalid"])
	await writeFile(path.join(root, "a.ts"), "old\n")
	await git(root, ["add", "."])
	await git(root, ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "commit", "-qm", "initial"])
	return root
}
beforeEach(async () => {
	directory = await realpath(await mkdtemp(path.join(tmpdir(), "walkthrough-test-")))
})
afterEach(async () => {
	await rm(directory, { recursive: true, force: true })
})

describe("walkthrough collection", () => {
	it("compares each real turn checkpoint and collapses later reversals into the net live diff", async () => {
		const root = await repo("repo")
		const before = (await git(root, ["rev-parse", "HEAD"])).trim()
		await writeFile(path.join(root, "a.ts"), "first turn\n")
		const middle = (await git(root, ["stash", "create"])).trim()
		await writeFile(path.join(root, "a.ts"), "old\n")
		const input = {
			taskId: "task",
			scope: "thread" as const,
			roots: [root],
			checkpointRoot: root,
			edits: [],
			checkpoints: [
				{ ref: before, runCount: 1 },
				{ ref: middle, runCount: 2 },
			],
			messages: [
				{ role: "user", content: "Change" },
				{ role: "assistant", content: "Changed" },
				{ role: "user", content: "Undo" },
				{ role: "assistant", content: "Undid" },
			] as Message[],
			runSpans: [1, 0, 1, 0],
		}
		expect((await collect(input)).walk.hunks).toEqual([])
		const last = await collect({ ...input, scope: "last_turn" })
		expect(last.walk.hunks[0].patch).toContain("-first turn\n+old")
		expect(last.walk.chapters[0].stops[0].prose).toBe("Undid")
	})

	it("uses the nearest checkpoint for a deduplicated unchanged turn", async () => {
		const root = await repo("repo")
		const before = (await git(root, ["rev-parse", "HEAD"])).trim()
		await writeFile(path.join(root, "a.ts"), "second turn\n")
		const result = await collect({
			taskId: "task",
			scope: "last_turn",
			roots: [root],
			checkpointRoot: root,
			edits: [],
			checkpoints: [{ ref: before, runCount: 1 }],
			messages: [
				{ role: "user", content: "Read" },
				{ role: "assistant", content: "Read only" },
				{ role: "user", content: "Edit" },
				{ role: "assistant", content: "Edited" },
			],
			runSpans: [1, 0, 1, 0],
		})
		expect(result.walk.hunks[0].turnId).toBe("turn2")
		expect(result.walk.chapters[0].stops[0].prose).toBe("Edited")
	})
	it("recovers earlier thread edits when compaction removed their messages", async () => {
		const root = await repo("repo")
		const first = (await git(root, ["rev-parse", "HEAD"])).trim()
		await writeFile(path.join(root, "a.ts"), "earlier edit\n")
		const latest = (await git(root, ["stash", "create"])).trim()
		const messages = [
			{ role: "user", content: "Summary", metadata: { kind: "compaction", displayRole: "system" } },
			{ role: "user", content: "Read only" },
			{ role: "assistant", content: "Read." },
		] as Message[]
		const result = await collect({
			taskId: "task",
			scope: "thread",
			roots: [root],
			checkpointRoot: root,
			edits: [],
			checkpoints: [
				{ ref: first, runCount: 1 },
				{ ref: latest, runCount: 3 },
			],
			messages,
			runSpans: [2, 1, 0],
		})
		expect(result.walk.hunks[0].patch).toContain("-old\n+earlier edit")
		expect(result.walk.chapters[0].title).toBe("Earlier edits")
		expect(result.walk.warnings.join(" ")).toContain("turn messages are unavailable")
	})
	it("prefixes multi-root git paths, including untracked files and staged edits", async () => {
		const a = await repo("api")
		const b = await repo("web")
		await writeFile(path.join(a, "a.ts"), "API\n")
		await git(a, ["add", "a.ts"])
		await writeFile(path.join(b, "new.ts"), "UI\n")
		const { walk } = await collect({
			taskId: "task",
			scope: "git",
			roots: [b, a],
			messages: [],
			runSpans: [],
			edits: [],
			checkpoints: [],
			checkpointRoot: a,
		})
		expect(walk.hunks.map((h) => h.path)).toEqual(["api/a.ts", "web/new.ts"])
		expect(walk.warnings).toEqual([])
	})
	it("disambiguates same-named roots and rejects paths outside the workspace", () => {
		const a = path.join(directory, "one", "module"),
			b = path.join(directory, "two", "module")
		expect(modulePath(path.join(a, "x.ts"), [a, b])).toMatch(/^module-[a-f0-9]{6}\/x.ts$/)
		expect(modulePath(path.join(a, "x.ts"), [a, b])).not.toBe(modulePath(path.join(b, "x.ts"), [a, b]))
		expect(() => modulePath("/outside/file", [a])).toThrow("outside")
	})
	it("compares real checkpoint snapshots and recovers stash-untracked before content", async () => {
		const root = await repo("repo")
		await writeFile(path.join(root, "a.ts"), "checkpoint\n")
		await writeFile(path.join(root, "new.ts"), "untracked before\n")
		await git(root, ["stash", "push", "-q", "--include-untracked"])
		const ref = (await git(root, ["rev-parse", "stash@{0}"])).trim()
		await git(root, ["stash", "apply", "-q"])
		await writeFile(path.join(root, "a.ts"), "after\n")
		await writeFile(path.join(root, "new.ts"), "untracked after\n")
		const changes = await changesBetween(root, [root], ref)
		expect(changes[0].before).toBe("checkpoint\n")
		expect(changes[0].after).toBe("after\n")
		expect(changes[1].before).toBe("untracked before\n")
		expect(changes[1].after).toBe("untracked after\n")
	})
	it("collects both sides of a git rename as reviewable file changes", async () => {
		const root = await repo("repo")
		await git(root, ["mv", "a.ts", "renamed.ts"])
		const changes = await changesBetween(root, [root], "HEAD")
		expect(changes.map((change) => change.path)).toEqual(["a.ts", "renamed.ts"])
		expect(changes[0].afterExists).toBe(false)
		expect(changes[1].beforeExists).toBe(false)
	})
	it("groups persisted editor changes by their real user turn and excludes orphaned journal entries", async () => {
		const root = await repo("repo")
		const messages: Message[] = [
			{ role: "user", content: "Edit parser" },
			{ role: "assistant", content: [{ type: "tool_use", id: "edit1", name: "editor", input: { path: "a.ts" } }] },
			{ role: "user", content: [{ type: "tool_result", name: "editor", tool_use_id: "edit1", content: "done" }] },
			{ role: "assistant", content: "Updated parsing." },
			{ role: "user", content: "Add tests" },
			{ role: "assistant", content: [{ type: "tool_use", id: "edit2", name: "editor", input: { path: "b.ts" } }] },
			{ role: "assistant", content: "Added coverage." },
		]
		const edit = (file: string, id: string) => ({
			filePath: path.join(root, file),
			before: "old\n",
			after: "new\n",
			beforeExists: true,
			afterExists: true,
			toolCallId: id,
			runId: "run",
		})
		const input = {
			taskId: "task",
			scope: "thread" as const,
			roots: [root],
			messages,
			runSpans: [1, 0, 0, 0, 1, 0, 0],
			edits: [edit("a.ts", "edit1"), edit("b.ts", "edit2"), edit("orphan.ts", "gone")],
			checkpoints: [],
			checkpointRoot: root,
		}
		await writeFile(path.join(root, "a.ts"), "new\n")
		await writeFile(path.join(root, "b.ts"), "new\n")
		const { walk } = await collect(input)
		expect(walk.chapters).toHaveLength(2)
		expect(walk.chapters[0].stops[0].prose).toBe("Updated parsing.")
		expect(walk.hunks.map((h) => h.path)).toEqual(["a.ts", "b.ts"])
		const last = await collect({ ...input, scope: "last_turn" })
		expect(last.walk.hunks.map((h) => h.path)).toEqual(["b.ts"])
	})
	it("respects runtime turn boundaries for tool results, synthetic prompts and status messages", () => {
		const messages = [
			{ role: "user", content: "Edit" },
			{ role: "user", content: [{ type: "tool_result", name: "editor", tool_use_id: "a", content: "done" }] },
			{ role: "user", content: "The user approved switching to act mode. Continue with the approved plan now." },
			{ role: "user", content: "Hook", metadata: { kind: "hook_context", displayRole: "system" } },
			{ role: "assistant", content: "Done." },
		] as Message[]
		expect(transcriptTurns(messages, [1, 0, 0, 0, 0]).turns).toHaveLength(1)
	})
	it("records actual before and after contents to a temp journal", async () => {
		const root = await repo("repo")
		const file = path.join(root, "a.ts")
		const result = await recordToolEdits(
			async () => directory,
			{ path: file, old_text: "old", new_text: "new" },
			root,
			{ agentId: "main", iteration: 1, toolCallId: "edit", runId: "run" },
			async () => {
				await writeFile(file, "new\n")
				return "ok"
			},
			(error) => {
				throw error
			},
		)
		expect(result).toBe("ok")
		expect(await readEdits(directory)).toEqual([
			{
				filePath: file,
				before: "old\n",
				after: "new\n",
				beforeExists: true,
				afterExists: true,
				toolCallId: "edit",
				runId: "run",
			},
		])
	})
	it("reports unavailable checkpoints instead of borrowing unrelated git changes", async () => {
		const root = await repo("repo")
		await writeFile(path.join(root, "a.ts"), "manual\n")
		const { walk } = await collect({
			taskId: "task",
			scope: "thread",
			roots: [root],
			messages: [{ role: "user", content: "Review" }],
			runSpans: [1],
			edits: [],
			checkpoints: [],
			checkpointRoot: root,
		})
		expect(walk.hunks).toEqual([])
		expect(walk.warnings[0]).toContain("No recorded edits")
	})
	it("reverts one exact hunk while preserving another and rejects stale files", async () => {
		const root = await repo("repo"),
			filePath = path.join(root, "a.ts")
		const before = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n") + "\n"
		const after = before.replace("line 1\n", "first edit\n").replace("line 28\n", "second edit\n")
		const change: ContentChange = { filePath, path: "a.ts", before, after, beforeExists: true, afterExists: true }
		const walk = fallback("task", "git", [], [change])
		expect(walk.hunks).toHaveLength(2)
		await writeFile(filePath, after)
		await revertChange(change, walk, "h1")
		const restored = await readFile(filePath, "utf8")
		expect(restored).toContain("line 1\n")
		expect(restored).toContain("second edit\n")
		await expect(revertChange(change, walk, "h2")).rejects.toThrow("File changed")
	})
	it("removes a newly created file and restores a deleted file", async () => {
		const root = await repo("repo"),
			filePath = path.join(root, "new.ts")
		const created: ContentChange = {
			filePath,
			path: "new.ts",
			before: "",
			after: "created\n",
			beforeExists: false,
			afterExists: true,
		}
		await writeFile(filePath, created.after)
		await revertChange(created, fallback("task", "git", [], [created]))
		await expect(readFile(filePath)).rejects.toMatchObject({ code: "ENOENT" })
		const deleted = { ...created, before: "restore\n", after: "", beforeExists: true, afterExists: false }
		await revertChange(deleted, fallback("task", "git", [], [deleted]))
		expect(await readFile(filePath, "utf8")).toBe("restore\n")
	})
	it("preserves CRLF and missing final newlines when reversing a hunk", async () => {
		const root = await repo("repo"),
			filePath = path.join(root, "a.ts")
		for (const [before, after] of [
			["old", "new"],
			["a\r\nb\r\n", "a\r\nB\r\n"],
		]) {
			const change: ContentChange = { filePath, path: "a.ts", before, after, beforeExists: true, afterExists: true }
			await writeFile(filePath, after)
			await revertChange(change, fallback("task", "git", [], [change]), "h1")
			expect(await readFile(filePath, "utf8")).toBe(before)
		}
	})
	it("keeps journals isolated by task directory", async () => {
		const other = path.join(directory, "other")
		await mkdir(other)
		await recordEdits(directory, [])
		expect(await readEdits(other)).toEqual([])
	})
})
