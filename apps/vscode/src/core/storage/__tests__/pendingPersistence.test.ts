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

describe("profile secret persistence", () => {
	it("waits for a locked secret save before publishing or resolving the configuration", async () => {
		const { saveApiProfile } = await import("@/core/controller/models/saveApiProfile")
		const { apiConfigurationForProfileId } = await import("@/core/controller/models/apiProfiles")
		;(StateManager as any).instance = manager
		let published = false
		const controller = {
			stateManager: manager,
			postStateToWebview: async () => {
				published = true
			},
		}
		const release = await acquireStorageLock(path.join(dir, "data/secrets.json.lock"))
		const saved = saveApiProfile(
			controller as any,
			{
				id: "locked",
				name: "Locked",
				provider: "anthropic",
				modelId: "claude",
				secrets: { apiKey: "new-key" },
			} as any,
		)
		let flushed = false
		await Bun.sleep(30)
		const flush = manager.flushPendingState().then(() => {
			flushed = true
		})
		try {
			await Bun.sleep(30)
			expect(published).toBe(false)
			expect(flushed).toBe(false)
			expect(manager.getGlobalStateKey("apiConfigProfiles")).toEqual([])
		} finally {
			release()
		}
		await saved
		await flush
		expect(published).toBe(true)
		expect(apiConfigurationForProfileId(manager, "locked", "act").apiKey).toBe("new-key")
		expect(JSON.parse(fs.readFileSync(path.join(dir, "data/secrets.json"), "utf8"))["profile:locked:apiKey"]).toBe("new-key")
		await manager.flushPendingState()
	})

	it("reports a secret lock timeout to the caller, flush, and error callback", async () => {
		const { upsertApiConfigProfile } = await import("@/core/controller/models/apiProfiles")
		const { StorageLockTimeoutError } = await import("@/shared/storage/storage-lock")
		;(StateManager as any).instance = manager
		const original = storage.secrets.withLock.bind(storage.secrets)
		storage.secrets.withLock = (operation) => original(operation, { timeoutMs: 40, retryMs: 5 })
		let reported: Error | undefined
		manager.registerCallbacks({
			onPersistenceError: ({ error }) => {
				reported = error
			},
		})
		const release = await acquireStorageLock(path.join(dir, "data/secrets.json.lock"))
		try {
			await expect(
				upsertApiConfigProfile(manager, {
					id: "timeout",
					name: "Timeout",
					provider: "anthropic",
					modelId: "claude",
					secrets: { apiKey: "key" },
				}),
			).rejects.toBeInstanceOf(StorageLockTimeoutError)
			await expect(manager.flushPendingState()).rejects.toBeInstanceOf(StorageLockTimeoutError)
			expect(reported).toBeInstanceOf(StorageLockTimeoutError)
			expect(manager.getGlobalStateKey("apiConfigProfiles")).toEqual([])
		} finally {
			release()
		}
	})

	it("waits for a tracked operation and persists the state it queues afterwards", async () => {
		const internals = manager as any
		let finish!: () => void
		const operation = manager.trackOperation(
			new Promise<void>((resolve) => {
				finish = resolve
			}).then(() => {
				internals.globalStateCache.queuedLater = "yes"
				internals.pendingGlobalState.add("queuedLater")
			}),
		)
		const flush = manager.flushPendingState()
		await Bun.sleep(20)
		finish()
		await Promise.all([operation, flush])
		const file = path.join(dir, "data/globalState.json")
		expect(JSON.parse(fs.readFileSync(file, "utf8"))).toMatchObject({ queuedLater: "yes" })
	})
})
