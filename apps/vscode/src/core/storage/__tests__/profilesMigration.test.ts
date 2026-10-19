import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { type ApiProfileStore, upsertApiConfigProfile } from "@/core/controller/models/apiProfiles"
import { readModelProfiles, saveModelProfiles } from "@/core/controller/models/modelProfiles"
import { ClineFileStorage } from "@/shared/storage/ClineFileStorage"
import { createStorageContext } from "@/shared/storage/storage-context"
import { acquireStorageLock } from "@/shared/storage/storage-lock"
import { StateManager } from "../StateManager"

let dir: string

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "profiles-migration-"))
})
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true })
})

/** A window: its own StateManager and storage instances over the shared directory. */
function openWindow() {
	const storage = createStorageContext({ clineDir: dir, workspaceStorageDir: path.join(dir, "workspace") })
	// StateManager is a singleton by default; windows are separate processes.
	const manager = new (StateManager as unknown as new (storage: unknown) => StateManager)(storage)
	// Remote-config filtering reaches for the singleton; any window will do.
	;(StateManager as unknown as { instance: StateManager }).instance = manager
	const internals = manager as unknown as {
		populateFromStorage(): Promise<void>
		reconcileProfilesUnderLock(options?: { timeoutMs: number }): Promise<void>
	}
	return {
		manager,
		storage,
		store: manager as unknown as ApiProfileStore,
		/** Read the files the way a window starting now would. */
		populate: () => internals.populateFromStorage(),
		/** The migration step of startup. */
		reconcile: (options?: { timeoutMs: number }) => internals.reconcileProfilesUnderLock(options),
		start: async () => {
			await manager.loadFromStorage()
		},
	}
}

/** The file as another process (or an older release) sees it. */
const readDisk = () => JSON.parse(fs.readFileSync(path.join(dir, "data", "globalState.json"), "utf-8")) as Record<string, any>
/** What an older release does: write its keys straight into the shared file. */
const olderReleaseWrites = (entries: Record<string, unknown>) => {
	const file = new ClineFileStorage(path.join(dir, "data", "globalState.json"), "OlderRelease")
	void file.setBatch(entries)
}

/** Seed two saved configurations the way the release before profiles left them. */
async function seedLegacyUser() {
	const window = openWindow()
	await window.populate()
	const claude = await upsertApiConfigProfile(window.store, {
		name: "Claude",
		provider: "anthropic",
		modelId: "claude-x",
		reasoningEffort: "high",
		secrets: { apiKey: "claude-key" },
	})
	const local = await upsertApiConfigProfile(window.store, {
		name: "Local",
		provider: "openai",
		modelId: "qwen",
		options: { openAiBaseUrl: "http://local/v1" },
		secrets: { openAiApiKey: "local-key" },
	})
	window.manager.setGlobalStateBatch({
		askProfileId: claude.id,
		actProfileId: claude.id,
		planModeReasoningEffort: "high",
		actModeReasoningEffort: "high",
		subagentDefaultProfileId: local.id,
	})
	await window.manager.flushPendingState()
	// Back to the state the release before profiles left behind.
	const file = new ClineFileStorage(path.join(dir, "data", "globalState.json"))
	await file.setBatch({ profiles: undefined, profilesMigration: undefined, threadSelectionStamp: undefined })
	return { claude, local }
}

describe("profile migration across releases and windows", () => {
	it("migrates once, persists in one write, and a restart changes nothing", async () => {
		const { claude, local } = await seedLegacyUser()

		const first = openWindow()
		await first.start()
		const afterFirst = readDisk()
		expect(afterFirst.profiles.map((p: any) => p.name)).toEqual(["Claude", "Local"])
		expect(afterFirst.profilesMigration.version).toBe(1)
		expect(afterFirst.threadSelectionStamp).toMatchObject({ askProfileId: claude.id, planModeReasoningEffort: "high" })
		expect(afterFirst.subagentDefaultModelProfileId).toBe(afterFirst.profiles[1].id)
		expect(afterFirst.subagentDefaultProfileId).toBe(local.id)

		const second = openWindow()
		await second.start()
		expect(readDisk()).toEqual(afterFirst)
	})

	it("adopts what an older release chose after a downgrade, instead of restoring the stale default", async () => {
		const { claude, local } = await seedLegacyUser()
		const upgraded = openWindow()
		await upgraded.start()
		expect(readDisk().askProfileId).toBe(claude.id)

		// Downgrade: the older release picks Local for Ask and Act.
		olderReleaseWrites({
			askProfileId: local.id,
			actProfileId: local.id,
			planModeReasoningEffort: "none",
			actModeReasoningEffort: "none",
		})

		const again = openWindow()
		await again.start()
		const disk = readDisk()
		const defaultProfile = disk.profiles.find((p: any) => p.id === disk.threadDefaultProfileId)
		expect(defaultProfile).toMatchObject({ name: "Local", configurationId: local.id })
		expect(disk.askProfileId).toBe(local.id)
		expect(disk.actProfileId).toBe(local.id)
		expect(again.manager.getGlobalStateKey("threadDefaultProfileId")).toBe(disk.threadDefaultProfileId)
	})

	it("does not mistake a selection this release made (focusing a chat) for a downgrade", async () => {
		const { claude, local } = await seedLegacyUser()
		const running = openWindow()
		await running.start()
		const defaultId = readDisk().threadDefaultProfileId

		// Focusing another chat restores its Local selection into the live keys.
		running.manager.setGlobalStateBatch({ askProfileId: local.id, planModeReasoningEffort: "none" })
		await running.manager.flushPendingState()
		expect(readDisk().threadSelectionStamp).toMatchObject({ askProfileId: local.id })

		const restarted = openWindow()
		await restarted.start()
		const disk = readDisk()
		expect(disk.threadDefaultProfileId).toBe(defaultId)
		// New threads start from the Claude default again, as before.
		expect(disk.askProfileId).toBe(claude.id)
		expect(disk.planModeReasoningEffort).toBe("high")
	})

	it("does not overwrite a default or profile saved by another window while this one was starting", async () => {
		const { claude, local } = await seedLegacyUser()

		// Window B reads the files, then stalls before its migration step.
		const stalled = openWindow()
		await stalled.populate()

		// Window A starts, migrates and the user saves a new profile and default.
		const winner = openWindow()
		await winner.start()
		const configurationIds = [claude.id, local.id]
		const [first, second] = readModelProfiles(winner.store)
		saveModelProfiles(winner.store, [
			first,
			second,
			{ name: "Newest", configurationId: configurationIds[1], reasoningEffort: "low" },
		])
		const newest = readModelProfiles(winner.store)[2]
		winner.manager.setGlobalStateBatch({ threadDefaultProfileId: newest.id })
		await winner.manager.flushPendingState()

		// B resumes: it must load A's result, not migrate from its stale view.
		await stalled.reconcile()
		await stalled.manager.flushPendingState()

		const disk = readDisk()
		expect(disk.profiles.map((p: any) => p.name)).toEqual(["Claude", "Local", "Newest"])
		expect(disk.threadDefaultProfileId).toBe(newest.id)
		expect(stalled.manager.getGlobalStateKey("threadDefaultProfileId")).toBe(newest.id)
		expect(readModelProfiles(stalled.store).map((p) => p.name)).toEqual(["Claude", "Local", "Newest"])
	})

	it("never lets a window with a stale view write back over newer keys", async () => {
		await seedLegacyUser()
		const stale = openWindow()
		await stale.populate()
		const other = openWindow()
		await other.start()
		other.manager.setGlobalState("subagentProfilesEnabled", true)
		await other.manager.flushPendingState()

		stale.manager.setGlobalState("threadTitlesEnabled", true)
		await stale.manager.flushPendingState()

		const disk = readDisk()
		expect(disk.subagentProfilesEnabled).toBe(true)
		expect(disk.threadTitlesEnabled).toBe(true)
	})

	it("migrates concurrently started windows exactly once", async () => {
		await seedLegacyUser()
		const windows = [openWindow(), openWindow(), openWindow()]
		await Promise.all(windows.map((window) => window.start()))
		const disk = readDisk()
		expect(disk.profiles.map((p: any) => p.name)).toEqual(["Claude", "Local"])
		const ids = new Set(windows.map((window) => window.manager.getGlobalStateKey("threadDefaultProfileId")))
		expect(ids).toEqual(new Set([disk.threadDefaultProfileId]))
		for (const window of windows) {
			expect(readModelProfiles(window.store).map((p) => p.id)).toEqual(disk.profiles.map((p: any) => p.id))
		}
		expect(fs.existsSync(path.join(dir, "data", "profiles-migration.lock"))).toBe(false)
	})
})

it("defers all migration writes on timeout and reloads the committed state", async () => {
	const window = openWindow()
	await window.populate()
	const file = path.join(dir, "data", "globalState.json")
	const release = await acquireStorageLock(`${file}.lock`)
	const committed = { threadTitlesEnabled: true, actModeApiProvider: "anthropic", actModeApiModelId: "claude-x" }
	fs.writeFileSync(file, JSON.stringify(committed))
	const before = fs.readFileSync(file, "utf8")
	try {
		await window.reconcile({ timeoutMs: 50 })
		await window.manager.flushPendingState()
		expect(fs.readFileSync(file, "utf8")).toBe(before)
		expect(fs.existsSync(path.join(dir, "data", "secrets.json"))).toBe(false)
		expect(window.manager.getGlobalStateKey("threadTitlesEnabled")).toBe(true)
		expect(window.manager.getGlobalStateKey("apiConfigProfiles")).toEqual([])
	} finally {
		release()
	}
	await window.reconcile()
	expect(readDisk().profilesMigration.version).toBe(1)
})

it("preserves an unrelated process write racing the real migration commit", async () => {
	await seedLegacyUser()
	const window = openWindow()
	const backing = window.storage.globalStateBackingStore
	const original = backing.withLock.bind(backing)
	let started = false
	let finished: Promise<void> | undefined
	backing.withLock = (operation, options) =>
		original(async () => {
			if (!started) {
				started = true
				const file = path.join(dir, "data", "globalState.json")
				const module = path.resolve(import.meta.dir, "../../../shared/storage/ClineFileStorage.ts")
				const worker = spawn(
					process.execPath,
					[
						"-e",
						`
				import { ClineFileStorage } from ${JSON.stringify(module)};
				console.log('ready');
				await new ClineFileStorage(${JSON.stringify(file)}).setBatch({unrelatedMigrationRace: 'saved'});
			`,
					],
					{ stdio: ["ignore", "pipe", "pipe"] },
				)
				let stderr = ""
				worker.stderr.on("data", (data) => {
					stderr += data
				})
				finished = new Promise<void>((resolve, reject) => {
					worker.once("error", reject)
					worker.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(stderr))))
				})
				await new Promise<void>((resolve, reject) => {
					worker.stdout.once("data", () => resolve())
					worker.once("error", reject)
					worker.once("exit", () => reject(new Error("writer exited before ready")))
				})
				await Bun.sleep(50)
				expect(readDisk().unrelatedMigrationRace).toBeUndefined()
			}
			return operation()
		}, options)
	await window.start()
	await finished
	const disk = readDisk()
	expect(disk.unrelatedMigrationRace).toBe("saved")
	expect(disk.profilesMigration.version).toBe(1)
	expect(disk.profiles.map((profile: { name: string }) => profile.name)).toEqual(["Claude", "Local"])
})
