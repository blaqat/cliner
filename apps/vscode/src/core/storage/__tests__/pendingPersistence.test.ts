import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createStorageContext } from "@/shared/storage/storage-context"
import { acquireStorageLock } from "@/shared/storage/storage-lock"
import { StateManager } from "../StateManager"

let dir: string
let manager: StateManager
let storage: ReturnType<typeof createStorageContext>
beforeEach(async () => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "pending-state-"))
	storage = createStorageContext({ clineDir: dir, workspaceStorageDir: path.join(dir, "workspace") })
	manager = new (StateManager as unknown as new (storage: unknown) => StateManager)(storage)
	await (manager as any).populateFromStorage()
})
afterEach(() => {
	;(manager as any).dispose()
	fs.rmSync(dir, { recursive: true, force: true })
})

const collections = [
	{ pending: "pendingGlobalState", cache: "globalStateCache", store: "globalStateBackingStore", file: "data/globalState.json" },
	{ pending: "pendingSecrets", cache: "secretsCache", store: "secrets", file: "data/secrets.json" },
	{
		pending: "pendingWorkspaceState",
		cache: "workspaceStateCache",
		store: "workspaceState",
		file: "workspace/workspaceState.json",
	},
] as const

describe("pending persistence", () => {
	for (const collection of collections) {
		it(`keeps changes made while ${collection.pending} waits on a lock`, async () => {
			const internals = manager as any
			const file = path.join(dir, collection.file)
			const release = await acquireStorageLock(`${file}.lock`)
			let first: Promise<void> | undefined
			try {
				internals[collection.cache].a = "first"
				internals[collection.pending].add("a")
				first = manager.flushPendingState()
				await Bun.sleep(30)
				internals[collection.cache].b = "second"
				internals[collection.pending].add("b")
			} finally {
				release()
			}
			await first
			await manager.flushPendingState()
			expect(JSON.parse(fs.readFileSync(file, "utf8"))).toMatchObject({ a: "first", b: "second" })
		})
		it(`restores failed ${collection.pending} using the newest value`, async () => {
			const internals = manager as any
			const store = storage[collection.store]
			const original = store.setBatch.bind(store)
			let reject!: (error: Error) => void
			store.setBatch = () =>
				new Promise<void>((_resolve, fail) => {
					reject = fail
				})
			internals[collection.cache].a = "old"
			internals[collection.pending].add("a")
			const handled = manager.flushPendingState()
			void handled.catch(() => {})
			await Bun.sleep(0)
			internals[collection.cache].a = "new"
			internals[collection.pending].add("a")
			reject(new Error("write failed"))
			await expect(handled).rejects.toThrow("write failed")
			store.setBatch = original
			await manager.flushPendingState()
			expect(JSON.parse(fs.readFileSync(path.join(dir, collection.file), "utf8")).a).toBe("new")
		})
	}
	it("serializes task writes and restores failed task keys", async () => {
		const internals = manager as any
		let reject!: (error: Error) => void
		let calls = 0
		internals.persistTaskStateBatch = async (tasks: Map<string, Set<string>>) => {
			calls++
			if (calls === 1)
				await new Promise<void>((_resolve, fail) => {
					reject = fail
				})
			const entries = Object.fromEntries([...(tasks.get("task") ?? [])].map((key) => [key, internals.taskStateCache[key]]))
			fs.writeFileSync(path.join(dir, "task.json"), JSON.stringify(entries))
		}
		internals.taskStateCache.a = "old"
		internals.pendingTaskState.set("task", new Set(["a"]))
		const handled = manager.flushPendingState()
		void handled.catch(() => {})
		await Bun.sleep(0)
		internals.taskStateCache.a = "new"
		internals.taskStateCache.b = "second"
		internals.pendingTaskState.set("task", new Set(["a", "b"]))
		const second = manager.flushPendingState()
		expect(calls).toBe(1)
		reject(new Error("task failed"))
		await expect(handled).rejects.toThrow("task failed")
		await second
		expect(JSON.parse(fs.readFileSync(path.join(dir, "task.json"), "utf8"))).toEqual({ a: "new", b: "second" })
	})
})
