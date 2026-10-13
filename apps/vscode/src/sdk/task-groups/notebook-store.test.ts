import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import type { NotebookChange } from "@shared/task-groups"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NotebookStore, slugifyNoteName } from "./notebook-store"
import { TaskGroupStore, taskGroupPaths } from "./task-group-store"

vi.mock("@/shared/services/Logger", () => ({
	Logger: { error: vi.fn(), log: vi.fn(), warn: vi.fn() },
}))

describe("NotebookStore", () => {
	let rootDir: string
	let groups: TaskGroupStore
	let store: NotebookStore
	let groupId: string

	beforeEach(async () => {
		rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "cline-notebook-"))
		groups = new TaskGroupStore(rootDir)
		store = new NotebookStore(rootDir)
		groupId = (await groups.createGroup({ title: "g" })).id
	})

	afterEach(async () => {
		await fs.rm(rootDir, { recursive: true, force: true })
	})

	function paths() {
		return taskGroupPaths(rootDir, groupId)
	}

	describe("slugifyNoteName", () => {
		it("kebab-cases names", () => {
			expect(slugifyNoteName("Dev Plan")).toBe("dev-plan")
			expect(slugifyNoteName("  codebase: map (v2)  ")).toBe("codebase-map-v2")
			expect(slugifyNoteName("PROJ-482")).toBe("proj-482")
		})
	})

	describe("createNote", () => {
		it("writes a frontmatter note file and returns its path", async () => {
			const note = await store.createNote(groupId, { name: "Dev Plan", description: "Steps 1-3" })
			expect(note.slug).toBe("dev-plan")
			expect(note.path).toBe(paths().noteFile("dev-plan"))

			const raw = await fs.readFile(note.path, "utf8")
			expect(raw).toContain("name: Dev Plan")
			expect(raw).toContain("description: Steps 1-3")
			expect(raw.startsWith("---")).toBe(true)
		})

		it("dedupes slug collisions with numeric suffixes", async () => {
			const first = await store.createNote(groupId, { name: "Dev Plan", description: "" })
			const second = await store.createNote(groupId, { name: "Dev Plan", description: "" })
			const third = await store.createNote(groupId, { name: "dev plan!", description: "" })
			expect(first.slug).toBe("dev-plan")
			expect(second.slug).toBe("dev-plan-2")
			expect(third.slug).toBe("dev-plan-3")
		})
	})

	describe("listNotes", () => {
		it("parses frontmatter and reports size, updatedAt, updatedBy", async () => {
			await store.createNote(groupId, { name: "A", description: "first" })
			const notes = await store.listNotes(groupId)
			expect(notes).toHaveLength(1)
			expect(notes[0].slug).toBe("a")
			expect(notes[0].name).toBe("A")
			expect(notes[0].description).toBe("first")
			expect(notes[0].size).toBeGreaterThan(0)
			expect(notes[0].updatedBy).toEqual({ kind: "user" })
		})

		it("reflects hand-edited frontmatter (name/description, thread updatedBy)", async () => {
			const note = await store.createNote(groupId, { name: "A", description: "" })
			await fs.writeFile(
				note.path,
				[
					"---",
					"name: Renamed by hand",
					"description: edited",
					"updated: 2030-01-02T03:04:05.000Z",
					"updatedBy:",
					"  kind: thread",
					"  threadId: t-1",
					"  threadTitle: Some thread",
					"---",
					"",
					"hand-written body",
				].join("\n"),
			)
			const notes = await store.listNotes(groupId)
			expect(notes[0].name).toBe("Renamed by hand")
			expect(notes[0].description).toBe("edited")
			expect(notes[0].updatedAt).toBe(Date.parse("2030-01-02T03:04:05.000Z"))
			expect(notes[0].updatedBy).toEqual({ kind: "thread", threadId: "t-1", threadTitle: "Some thread" })
		})

		it("falls back to slug name and file mtime for a note with no frontmatter", async () => {
			const filePath = paths().noteFile("plain")
			await fs.mkdir(paths().notebookDir, { recursive: true })
			await fs.writeFile(filePath, "just markdown, no frontmatter")
			const notes = await store.listNotes(groupId)
			expect(notes[0].name).toBe("plain")
			expect(notes[0].description).toBe("")
			expect(notes[0].updatedBy).toEqual({ kind: "user" })
		})
	})

	describe("readNote", () => {
		it("returns the body and appends a read activity when threadId is given", async () => {
			const note = await store.createNote(groupId, { name: "A", description: "d" })
			await fs.appendFile(note.path, "the body\n")

			const read = await store.readNote(groupId, "a", "thread-1")
			expect(read?.meta.name).toBe("A")
			expect(read?.content).toContain("the body")

			const activity = await store.listActivity(groupId)
			expect(activity).toEqual([{ ts: expect.any(Number), threadId: "thread-1", kind: "read", slug: "a" }])
		})

		it("returns undefined for a missing slug without logging activity", async () => {
			expect(await store.readNote(groupId, "nope", "thread-1")).toBeUndefined()
			expect(await store.listActivity(groupId)).toEqual([])
		})
	})

	describe("staging", () => {
		const change: NotebookChange = { op: "create", slug: "plan", name: "Plan", description: "d", content: "v1" }

		it("stages changes into pending/<threadId>.json", async () => {
			await store.stageChange(groupId, "t-1", change)
			expect(await store.readPending(groupId, "t-1")).toEqual([change])
		})

		it("merges staged changes per slug (create stays create on update)", async () => {
			await store.stageChange(groupId, "t-1", change)
			await store.stageChange(groupId, "t-1", { ...change, content: "v2", op: "update" })
			const pending = await store.readPending(groupId, "t-1")
			expect(pending).toHaveLength(1)
			expect(pending?.[0]).toMatchObject({ op: "create", content: "v2" })
		})

		it("a staged delete after a staged create cancels out (and drops the pending file)", async () => {
			await store.stageChange(groupId, "t-1", change)
			await store.stageChange(groupId, "t-1", { ...change, op: "delete" })
			expect(await store.readPending(groupId, "t-1")).toBeUndefined()
			expect(await store.findPending("t-1")).toBeUndefined()
		})

		it("findPending locates a thread's staged changes without a group id", async () => {
			await store.stageChange(groupId, "t-1", change)
			expect(await store.findPending("t-1")).toEqual({ groupId, changes: [change] })
			expect(await store.findPending("nobody")).toBeUndefined()
		})
	})

	describe("applyPendingChanges", () => {
		it("applies included changes, stamps thread updatedBy, and clears the pending file", async () => {
			await store.stageChange(groupId, "t-1", { op: "create", slug: "a", name: "A", description: "da", content: "body a" })
			await store.stageChange(groupId, "t-1", { op: "create", slug: "b", name: "B", description: "db", content: "body b" })

			const applied = await store.applyPendingChanges(
				"t-1",
				[
					{ slug: "a", include: true, editedContent: "edited a" },
					{ slug: "b", include: false },
				],
				{ threadTitle: "Thread title" },
			)

			expect(applied).toHaveLength(1)
			const noteA = await fs.readFile(paths().noteFile("a"), "utf8")
			expect(noteA).toContain("edited a")
			expect(noteA).toContain("kind: thread")
			expect(noteA).toContain("threadId: t-1")
			await expect(fs.stat(paths().noteFile("b"))).rejects.toThrow()
			expect(await store.findPending("t-1")).toBeUndefined()

			const activity = await store.listActivity(groupId)
			expect(activity).toEqual([{ ts: expect.any(Number), threadId: "t-1", kind: "write", slug: "a" }])
		})

		it("applies a delete change", async () => {
			await store.createNote(groupId, { name: "A", description: "" })
			await store.stageChange(groupId, "t-1", { op: "delete", slug: "a", name: "A", description: "" })
			await store.applyPendingChanges("t-1", [{ slug: "a", include: true }])
			await expect(fs.stat(paths().noteFile("a"))).rejects.toThrow()
		})

		it("is a no-op when nothing is staged", async () => {
			expect(await store.applyPendingChanges("nobody", [])).toEqual([])
		})
	})

	describe("discardPendingChanges", () => {
		it("removes the pending file without applying", async () => {
			await store.stageChange(groupId, "t-1", { op: "create", slug: "a", name: "A", description: "", content: "x" })
			await store.discardPendingChanges("t-1")
			expect(await store.findPending("t-1")).toBeUndefined()
			await expect(fs.stat(paths().noteFile("a"))).rejects.toThrow()
		})
	})

	describe("activity", () => {
		it("summarizes read/wrote slugs per thread", async () => {
			await store.appendActivity(groupId, { ts: 1, threadId: "t-1", kind: "read", slug: "a" })
			await store.appendActivity(groupId, { ts: 2, threadId: "t-1", kind: "read", slug: "a" })
			await store.appendActivity(groupId, { ts: 3, threadId: "t-1", kind: "write", slug: "b" })
			await store.appendActivity(groupId, { ts: 4, threadId: "t-2", kind: "read", slug: "a" })

			const summary = await store.summarizeActivity(groupId)
			expect(summary.get("t-1")).toEqual({ read: ["a"], wrote: ["b"] })
			expect(summary.get("t-2")).toEqual({ read: ["a"], wrote: [] })
		})

		it("counts distinct reader threads on note metas", async () => {
			await store.createNote(groupId, { name: "A", description: "" })
			await store.appendActivity(groupId, { ts: 1, threadId: "t-1", kind: "read", slug: "a" })
			await store.appendActivity(groupId, { ts: 2, threadId: "t-2", kind: "read", slug: "a" })
			await store.appendActivity(groupId, { ts: 3, threadId: "t-1", kind: "read", slug: "a" })

			const notes = await store.listNotes(groupId)
			expect(notes[0].readers).toBe(2)
		})

		it("skips malformed lines in activity.jsonl", async () => {
			await store.appendActivity(groupId, { ts: 1, threadId: "t-1", kind: "read", slug: "a" })
			await fs.appendFile(paths().activityFile, 'not json\n{"kind":"mystery"}\n')
			expect(await store.listActivity(groupId)).toHaveLength(1)
		})
	})
})
