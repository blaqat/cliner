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

	it("user edit is read by the thread and queues a compact notice exactly once", async () => {
		await store.stageChange(groupId, "thread", {
			op: "create",
			slug: "plan",
			name: "Plan",
			description: "",
			content: "agent draft",
		})
		const first = (await store.readPendingReview(groupId, "thread"))!
		const revision = await store.editPending(groupId, "thread", first.revision, "plan", "user draft")
		expect(revision).not.toBe(first.revision)
		expect(await store.readThreadNote(groupId, "thread", "plan", "thread")).toEqual({ name: "Plan", content: "user draft" })
		const notice = await store.consumeNotices(groupId, "thread")
		expect(notice).toContain("The user edited the pending note `Plan`; build on this version")
		expect(notice).toContain("-agent draft")
		expect(notice).toContain("+user draft")
		expect(await store.consumeNotices(groupId, "thread")).toBeUndefined()
		await expect(store.editPending(groupId, "thread", first.revision, "plan", "stale")).rejects.toThrow("newest review")
		await store.stageChange(groupId, "thread", {
			op: "create",
			slug: "plan",
			name: "Plan",
			description: "",
			content: "agent replaces",
		})
		const change = (await store.readPending(groupId, "thread"))?.[0]
		if (!change) throw new Error("Expected the replacement draft")
		expect(change.editedByUser).toBeUndefined()
		expect((await store.history(groupId, "plan")).find((version) => version.id === change.replacedUserVersion)?.content).toBe(
			"user draft",
		)
	})

	it("discard queues only the note name and never its text", async () => {
		await store.stageChange(groupId, "thread", {
			op: "create",
			slug: "plan",
			name: "Plan",
			description: "",
			content: "private draft",
		})
		const pending = await store.readPendingReview(groupId, "thread")
		if (!pending) throw new Error("Expected a draft")
		await store.editPending(groupId, "thread", pending.revision, "plan", "user private draft")
		await discard("thread")
		expect(await store.consumeNotices(groupId, "thread")).toBe("The user discarded your pending edits to `Plan`")
		expect(await store.readPending(groupId, "thread")).toBeUndefined()
	})

	it("retains the original and the last 20 versions and restores with history", async () => {
		const note = await store.createNote(groupId, { name: "Plan", description: "" })
		for (let i = 0; i < 25; i++) await store.recordVersion(groupId, note.slug, `version ${i}`, "you edited")
		const versions = await store.history(groupId, note.slug)
		expect(versions).toHaveLength(21)
		expect(versions[0].content).toBe("")
		expect(versions[1].content).toBe("version 5")
		expect(versions[20].content).toBe("version 24")
		await store.restoreVersion(groupId, note.slug, versions[1].id)
		expect((await store.readNote(groupId, note.slug))?.content).toBe("version 5")
		expect((await store.history(groupId, note.slug))[0].id).toBe(versions[0].id)
	})

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

	it.each(["apply", "discard"])("preserves another store's stage while %s holds the pending lock", async (action) => {
		const otherStore = new NotebookStore(rootDir)
		await store.createNote(groupId, { name: "Plan", description: "" })
		const change: NotebookChange = { op: "update", slug: "plan", name: "Plan", description: "", content: "v1" }
		await store.stageChange(groupId, "thread", change)
		const review = (await store.readPendingReview(groupId, "thread"))!
		let resume!: () => void
		let entered!: () => void
		const paused = new Promise<void>((resolve) => {
			entered = resolve
		})
		const released = new Promise<void>((resolve) => {
			resume = resolve
		})
		const originalWrite = fs.writeFile.bind(fs)
		const originalRemove = fs.rm.bind(fs)
		vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
			if (action === "apply" && String(args[0]).includes("plan.md.tmp-")) {
				entered()
				await released
			}
			return originalWrite(...args)
		})
		vi.spyOn(fs, "rm").mockImplementation(async (...args) => {
			if (action === "discard" && args[0] === paths().pendingFile("thread")) {
				entered()
				await released
			}
			return originalRemove(...args)
		})
		const finish =
			action === "apply"
				? store.applyPendingChanges(groupId, "thread", review.revision, [{ slug: "plan", include: true }])
				: store.discardPendingChanges(groupId, "thread", review.revision)
		await paused
		let attempted!: () => void
		const attempt = new Promise<void>((resolve) => {
			attempted = resolve
		})
		const originalOpen = fs.open.bind(fs)
		const lockPath = path.join(paths().pendingDir, "thread.lock")
		vi.spyOn(fs, "open").mockImplementation(async (...args) => {
			if (args[0] === lockPath && args[1] === "wx") attempted()
			return originalOpen(...args)
		})
		let staged = false
		const nextChange: NotebookChange = { ...change, op: "update", content: "v2" }
		const stage = otherStore.stageChange(groupId, "thread", nextChange).then(() => {
			staged = true
			attempted()
		})
		try {
			await attempt
			expect(staged).toBe(false)
			expect((await otherStore.readPendingReview(groupId, "thread"))?.revision).toBe(review.revision)
		} finally {
			resume()
			await Promise.all([finish, stage])
		}
		expect(await store.readPending(groupId, "thread")).toEqual([nextChange])
		if (action === "apply") expect((await store.readNote(groupId, "plan"))?.content).toBe("v1")
		await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" })
	})

	it.each(["dead owner", "incomplete owner"])("recovers a stale pending lock with %s", async (owner) => {
		await fs.mkdir(paths().pendingDir, { recursive: true })
		const lockPath = path.join(paths().pendingDir, "thread.lock")
		await fs.writeFile(lockPath, owner === "dead owner" ? JSON.stringify({ pid: 2147483647, timestamp: Date.now() }) : "")
		if (owner === "incomplete owner") {
			const staleAt = new Date(Date.now() - 31_000)
			await fs.utimes(lockPath, staleAt, staleAt)
		}
		const change: NotebookChange = { op: "create", slug: "plan", name: "Plan", description: "", content: "draft" }
		await Promise.all([
			store.stageChange(groupId, "thread", change),
			new NotebookStore(rootDir).stageChange(groupId, "thread", { ...change, slug: "other" }),
		])
		expect((await store.readPending(groupId, "thread"))?.map((entry) => entry.slug).sort()).toEqual(["other", "plan"])
		await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" })
	})

	it("waits for a live owner even when the pending lock is older than the timeout", async () => {
		await fs.mkdir(paths().pendingDir, { recursive: true })
		const lockPath = path.join(paths().pendingDir, "thread.lock")
		const staleAt = new Date(Date.now() - 31_000)
		const owner = JSON.stringify({ pid: process.pid, timestamp: staleAt.getTime() })
		await fs.writeFile(lockPath, owner)
		await fs.utimes(lockPath, staleAt, staleAt)
		let checked!: () => void
		const checkedOwner = new Promise<void>((resolve) => {
			checked = resolve
		})
		const originalKill = process.kill.bind(process)
		vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
			const result = originalKill(pid, signal)
			checked()
			return result
		})
		let staged = false
		const change: NotebookChange = { op: "create", slug: "plan", name: "Plan", description: "", content: "draft" }
		const stage = store.stageChange(groupId, "thread", change).then(() => {
			staged = true
		})
		try {
			await checkedOwner
			expect(await fs.readFile(lockPath, "utf8")).toBe(owner)
			expect(staged).toBe(false)
		} finally {
			await fs.rm(lockPath)
			await stage
		}
		expect(await store.readPending(groupId, "thread")).toEqual([change])
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
		await expect(fs.stat(path.join(paths().pendingDir, "thread.lock"))).rejects.toMatchObject({ code: "ENOENT" })
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
