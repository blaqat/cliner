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
		vi.restoreAllMocks()
		await fs.rm(rootDir, { recursive: true, force: true })
	})

	function paths() {
		return taskGroupPaths(rootDir, groupId)
	}

	async function apply(
		threadId: string,
		items: { slug: string; include: boolean; editedContent?: string }[],
		options?: { threadTitle?: string },
	) {
		const review = await store.readPendingReview(groupId, threadId)
		return store.applyPendingChanges(groupId, threadId, review?.revision ?? "", items, options)
	}
	async function discard(threadId: string) {
		const review = await store.readPendingReview(groupId, threadId)
		return store.discardPendingChanges(groupId, threadId, review?.revision ?? "")
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
			expect(await store.findPending("t-1")).toEqual({ groupId, revision: expect.any(String), changes: [change] })
			expect(await store.findPending("nobody")).toBeUndefined()
		})
	})

	describe("applyPendingChanges", () => {
		it("applies included changes, stamps thread updatedBy, and keeps unchecked work", async () => {
			await store.stageChange(groupId, "t-1", { op: "create", slug: "a", name: "A", description: "da", content: "body a" })
			await store.stageChange(groupId, "t-1", { op: "create", slug: "b", name: "B", description: "db", content: "body b" })

			const applied = await apply(
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
			expect((await store.readPending(groupId, "t-1"))?.map((change) => change.slug)).toEqual(["b"])

			const activity = await store.listActivity(groupId)
			expect(activity).toEqual([{ ts: expect.any(Number), threadId: "t-1", kind: "write", slug: "a" }])
		})

		it("applies a delete change", async () => {
			await store.createNote(groupId, { name: "A", description: "" })
			await store.stageChange(groupId, "t-1", { op: "delete", slug: "a", name: "A", description: "" })
			await apply("t-1", [{ slug: "a", include: true }])
			await expect(fs.stat(paths().noteFile("a"))).rejects.toThrow()
		})

		it("rejects a missing review instead of silently applying", async () => {
			await expect(apply("nobody", [])).rejects.toThrow("newest review card")
		})
	})

	describe("discardPendingChanges", () => {
		it("removes the pending file without applying", async () => {
			await store.stageChange(groupId, "t-1", { op: "create", slug: "a", name: "A", description: "", content: "x" })
			await discard("t-1")
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
	it.each([
		"..",
		"/",
		"\\",
		"/tmp/absolute",
		"C:\\absolute",
		"",
		"../../other-group/notebook/secret",
	])("rejects unsafe notebook identifiers %j before file operations", async (bad) => {
		const read = vi.spyOn(fs, "readFile")
		const write = vi.spyOn(fs, "writeFile")
		await expect(store.createNote(bad, { name: "Plan", description: "" })).rejects.toThrow("Invalid")
		await expect(store.readNote(groupId, bad)).rejects.toThrow("Invalid")
		await expect(store.readPending(groupId, bad)).rejects.toThrow("Invalid")
		await expect(
			store.stageChange(groupId, "thread", { op: "create", slug: bad, name: "Plan", description: "" }),
		).rejects.toThrow("Invalid")
		expect(() => store.notePath(groupId, bad)).toThrow("Invalid")
		expect(read).not.toHaveBeenCalled()
		expect(write).not.toHaveBeenCalled()
	})

	it("rejects stale apply and discard revisions after the next stage", async () => {
		const change: NotebookChange = { op: "create", slug: "plan", name: "Plan", description: "", content: "v1" }
		await store.stageChange(groupId, "thread", change)
		const old = (await store.readPendingReview(groupId, "thread"))!
		await store.stageChange(groupId, "thread", { ...change, content: "v2" })
		await expect(
			store.applyPendingChanges(groupId, "thread", old.revision, [{ slug: "plan", include: true }]),
		).rejects.toThrow("newest review card")
		await expect(store.discardPendingChanges(groupId, "thread", old.revision)).rejects.toThrow("newest review card")
		expect(await store.readNote(groupId, "plan")).toBeUndefined()
		expect((await store.readPendingReview(groupId, "thread"))?.revision).not.toBe(old.revision)
		await apply("thread", [{ slug: "plan", include: true }])
		expect((await store.readNote(groupId, "plan"))?.content).toBe("v2")
	})

	it.each(["apply", "discard"])("serializes a concurrent stage after %s without deleting it", async (action) => {
		const change: NotebookChange = { op: "create", slug: "plan", name: "Plan", description: "", content: "v1" }
		await store.stageChange(groupId, "thread", change)
		const review = (await store.readPendingReview(groupId, "thread"))!
		const finish =
			action === "apply"
				? store.applyPendingChanges(groupId, "thread", review.revision, [{ slug: "plan", include: true }])
				: store.discardPendingChanges(groupId, "thread", review.revision)
		const stage = store.stageChange(groupId, "thread", { ...change, op: "update", content: "v2" })
		await Promise.all([finish, stage])
		expect(await store.readPending(groupId, "thread")).toEqual([{ ...change, op: "update", content: "v2" }])
	})

	it("retains failed and unprocessed changes after a mocked write failure and retries", async () => {
		for (const slug of ["a", "b", "c"]) {
			await store.createNote(groupId, { name: slug, description: "" })
			await store.stageChange(groupId, "thread", {
				op: "update",
				slug,
				name: slug,
				description: "",
				content: `body ${slug}`,
			})
		}
		const review = (await store.readPendingReview(groupId, "thread"))!
		const original = fs.writeFile.bind(fs)
		vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
			if (String(args[0]).includes("b.md.tmp-")) throw new Error("disk full")
			return original(...args)
		})
		const items = ["a", "b", "c"].map((slug) => ({ slug, include: true, editedContent: `edited ${slug}` }))
		await expect(store.applyPendingChanges(groupId, "thread", review.revision, items)).rejects.toThrow("disk full")
		const remaining = (await store.readPendingReview(groupId, "thread"))!
		expect(remaining.revision).not.toBe(review.revision)
		expect(remaining.changes.map((change) => [change.slug, change.content])).toEqual([
			["b", "edited b"],
			["c", "edited c"],
		])
		expect((await store.readNote(groupId, "a"))?.content).toBe("edited a")
		vi.restoreAllMocks()
		await store.applyPendingChanges(groupId, "thread", remaining.revision, items)
		expect(await store.readPending(groupId, "thread")).toBeUndefined()
		expect((await store.readNote(groupId, "b"))?.content).toBe("edited b")
	})

	it("lists pending reviews across groups and applies or discards only the addressed group", async () => {
		const other = (await groups.createGroup({ title: "B" })).id
		const change: NotebookChange = { op: "create", slug: "plan", name: "Plan", description: "", content: "Draft" }
		await store.stageChange(groupId, "thread", change)
		await store.stageChange(other, "thread", change)
		expect(await store.listPending("thread")).toHaveLength(2)
		const review = (await store.readPendingReview(other, "thread"))!
		await store.applyPendingChanges(other, "thread", review.revision, [{ slug: "plan", include: true }])
		expect(await store.readNote(groupId, "plan")).toBeUndefined()
		expect(await store.readPending(groupId, "thread")).toEqual([change])
		await discard("thread")
		expect(await store.listPending("thread")).toEqual([])
	})

	it("reserves concurrent creates of Plan exclusively", async () => {
		const notes = await Promise.all(
			["first", "second"].map((description) => store.createNote(groupId, { name: "Plan", description })),
		)
		expect(notes.map((note) => note.slug).sort()).toEqual(["plan", "plan-2"])
		expect((await store.listNotes(groupId)).map((note) => note.description).sort()).toEqual(["first", "second"])
	})

	it("applies a create to a new slug if its reviewed slug was taken", async () => {
		await store.stageChange(groupId, "thread", {
			op: "create",
			slug: "plan",
			name: "Plan",
			description: "",
			content: "reviewed",
		})
		await store.createNote(groupId, { name: "Plan", description: "user note" })
		const applied = await apply("thread", [{ slug: "plan", include: true }])
		expect(applied[0].slug).toBe("plan-2")
		expect((await store.readNote(groupId, "plan"))?.meta.description).toBe("user note")
		expect((await store.readNote(groupId, "plan-2"))?.content).toBe("reviewed")
	})

	it("attributes a newer hand edit to the user using mtime with two seconds slack", async () => {
		await store.stageChange(groupId, "thread", {
			op: "create",
			slug: "plan",
			name: "Plan",
			description: "",
			content: "draft",
		})
		await apply("thread", [{ slug: "plan", include: true }])
		const original = (await store.readNote(groupId, "plan"))!.meta
		expect(original.updatedBy.kind).toBe("thread")
		await fs.utimes(paths().noteFile("plan"), new Date(), new Date(original.updatedAt + 1000))
		expect((await store.readNote(groupId, "plan"))?.meta.updatedBy.kind).toBe("thread")
		await fs.appendFile(paths().noteFile("plan"), "hand edit")
		await fs.utimes(paths().noteFile("plan"), new Date(), new Date(original.updatedAt + 3000))
		const edited = (await store.readNote(groupId, "plan"))!.meta
		expect(edited.updatedAt).toBeCloseTo(original.updatedAt + 3000, 0)
		expect(edited.updatedBy).toEqual({ kind: "user" })
	})
})
