import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import type { TaskTag } from "@shared/task-groups"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { TaskGroupStore, taskGroupPaths } from "./task-group-store"

vi.mock("@/shared/services/Logger", () => ({
	Logger: { error: vi.fn(), log: vi.fn(), warn: vi.fn() },
}))

const branchTag: TaskTag = { kind: "branch", value: "feat/export", source: "user" }
const ticketTag: TaskTag = { kind: "ticket", value: "PROJ-482", source: "auto" }
const labelTag: TaskTag = { kind: "label", value: "backend", source: "user" }

describe("TaskGroupStore", () => {
	let rootDir: string
	let store: TaskGroupStore

	beforeEach(async () => {
		rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "cline-task-groups-"))
		store = new TaskGroupStore(rootDir)
	})

	afterEach(async () => {
		vi.restoreAllMocks()
		await fs.rm(rootDir, { recursive: true, force: true })
	})

	it("creates and reads back a group (round-trip)", async () => {
		const group = await store.createGroup({ title: "Fix auth", tags: [ticketTag, labelTag] })

		expect(group.id).toBeTruthy()
		expect(group.title).toBe("Fix auth")
		expect(group.tags).toEqual([ticketTag, labelTag])
		expect(group.createdAt).toBe(group.updatedAt)

		const read = await store.getGroup(group.id)
		expect(read).toEqual(group)
	})

	it("creates the group.json file under <root>/<id>/", async () => {
		const group = await store.createGroup({ title: "x" })
		const raw = await fs.readFile(taskGroupPaths(rootDir, group.id).groupFile, "utf8")
		expect(JSON.parse(raw).title).toBe("x")
	})

	it("lists groups newest-updated first", async () => {
		let now = 1000
		vi.spyOn(Date, "now").mockImplementation(() => now++)
		const older = await store.createGroup({ title: "older" })
		const newer = await store.createGroup({ title: "newer" })
		// Bump `older`'s updatedAt so it outranks the later-created group.
		await store.updateGroup(older.id, { title: "older v2" })
		const groups = await store.listGroups()
		expect(groups.map((g) => g.id)).toEqual([older.id, newer.id])
	})

	it("updates title and tags independently", async () => {
		const group = await store.createGroup({ title: "a", tags: [ticketTag] })
		const renamed = await store.updateGroup(group.id, { title: "b" })
		expect(renamed?.title).toBe("b")
		expect(renamed?.tags).toEqual([ticketTag])

		const retagged = await store.updateGroup(group.id, { tags: [] })
		expect(retagged?.title).toBe("b")
		expect(retagged?.tags).toEqual([])
	})

	it("persists the branch-suggestion dismissal without bumping updatedAt, and keeps it across other edits", async () => {
		let now = 1000
		vi.spyOn(Date, "now").mockImplementation(() => now++)
		const group = await store.createGroup({ title: "a", tags: [branchTag] })
		expect(group.branchSuggestionDismissed).toBeUndefined()

		const dismissed = await store.updateGroup(group.id, { branchSuggestionDismissed: true })
		expect(dismissed?.branchSuggestionDismissed).toBe(true)
		expect(dismissed?.updatedAt).toBe(group.updatedAt)

		// A fresh store (a reload) reads it back from disk.
		const reloaded = await new TaskGroupStore(rootDir).getGroup(group.id)
		expect(reloaded?.branchSuggestionDismissed).toBe(true)
		expect((await new TaskGroupStore(rootDir).listGroupSummaries())[0].branchSuggestionDismissed).toBe(true)

		const renamed = await store.updateGroup(group.id, { title: "b" })
		expect(renamed?.branchSuggestionDismissed).toBe(true)
		expect(renamed?.updatedAt).toBeGreaterThan(group.updatedAt)

		const cleared = await store.updateGroup(group.id, { branchSuggestionDismissed: false })
		expect(cleared?.branchSuggestionDismissed).toBeUndefined()
		const raw = JSON.parse(await fs.readFile(taskGroupPaths(rootDir, group.id).groupFile, "utf8"))
		expect(raw).not.toHaveProperty("branchSuggestionDismissed")
	})

	it("returns undefined when updating or reading a missing group", async () => {
		expect(await store.getGroup("nope")).toBeUndefined()
		expect(await store.updateGroup("nope", { title: "x" })).toBeUndefined()
	})

	it("deletes a group's whole directory", async () => {
		const group = await store.createGroup({ title: "gone" })
		const paths = taskGroupPaths(rootDir, group.id)
		await fs.mkdir(paths.notebookDir, { recursive: true })
		await fs.writeFile(paths.noteFile("n"), "body")

		expect(await store.deleteGroup(group.id)).toBe(true)
		await expect(fs.stat(paths.dir)).rejects.toThrow()
		expect(await store.getGroup(group.id)).toBeUndefined()
		expect(await store.deleteGroup(group.id)).toBe(true) // rm force: already gone
	})

	it("skips directories with corrupt or missing group.json in listGroups", async () => {
		const good = await store.createGroup({ title: "good" })
		await fs.mkdir(path.join(rootDir, "broken"), { recursive: true })
		await fs.writeFile(path.join(rootDir, "broken", "group.json"), "{not json")
		await fs.mkdir(path.join(rootDir, "empty-dir"), { recursive: true })

		const groups = await store.listGroups()
		expect(groups.map((g) => g.id)).toEqual([good.id])
	})

	it("drops malformed tags on read but keeps valid ones", async () => {
		const group = await store.createGroup({ title: "x", tags: [ticketTag] })
		const paths = taskGroupPaths(rootDir, group.id)
		const raw = JSON.parse(await fs.readFile(paths.groupFile, "utf8"))
		raw.tags.push({ kind: "bogus", value: "x", source: "user" }, { value: 42 })
		await fs.writeFile(paths.groupFile, JSON.stringify(raw))

		const read = await store.getGroup(group.id)
		expect(read?.tags).toEqual([ticketTag])
	})

	it("counts notes for summaries", async () => {
		const group = await store.createGroup({ title: "x" })
		const paths = taskGroupPaths(rootDir, group.id)
		await fs.mkdir(paths.notebookDir, { recursive: true })
		await fs.writeFile(paths.noteFile("a"), "a")
		await fs.writeFile(paths.noteFile("b"), "b")
		await fs.writeFile(path.join(paths.notebookDir, "not-a-note.txt"), "x")

		const summaries = await store.listGroupSummaries()
		expect(summaries).toHaveLength(1)
		expect(summaries[0].noteCount).toBe(2)
	})

	it("listGroups on a missing root returns []", async () => {
		const missing = new TaskGroupStore(path.join(rootDir, "does-not-exist"))
		expect(await missing.listGroups()).toEqual([])
	})
	it.each([
		"..",
		"/",
		"\\",
		"/tmp/absolute",
		"C:\\absolute",
		"",
	])("rejects unsafe group identifiers %j before any fs operation", async (bad) => {
		const read = vi.spyOn(fs, "readFile")
		const remove = vi.spyOn(fs, "rm")
		await expect(store.deleteGroup(bad)).rejects.toThrow("Invalid")
		await expect(store.getGroup(bad)).rejects.toThrow("Invalid")
		await expect(store.noteCount(bad)).rejects.toThrow("Invalid")
		expect(() => taskGroupPaths(rootDir, bad)).toThrow("Invalid")
		expect(read).not.toHaveBeenCalled()
		expect(remove).not.toHaveBeenCalled()
	})
})
