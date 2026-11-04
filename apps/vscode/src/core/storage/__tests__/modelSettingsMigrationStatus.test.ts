import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { InMemoryConnectionSecretStore } from "@/sdk/model-settings/connection-secret-store"
import { createStorageContext } from "@/shared/storage/storage-context"
import { acquireStorageLock } from "@/shared/storage/storage-lock"

mock.module("@/sdk/model-settings/rollout", () => ({
	MODEL_SETTINGS_ROLLOUT_ENABLED: true,
	modelSettingsRolloutEnabled: () => true,
}))
const { StateManager } = await import("../StateManager")
type StateManagerType = import("../StateManager").StateManager

let dir: string
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "settings-migration-status-"))
})
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true })
})

function openWindow(secrets?: InMemoryConnectionSecretStore) {
	const storage = createStorageContext({ clineDir: dir, workspaceStorageDir: path.join(dir, "workspace") })
	const manager = new (StateManager as unknown as new (storage: unknown) => StateManagerType)(storage)
	;(StateManager as unknown as { instance: unknown }).instance = manager
	manager.connectionSecrets = secrets
	return { manager, storage }
}
const seed = async (window: ReturnType<typeof openWindow>) => {
	await window.storage.globalState.setBatch({
		apiConfigProfiles: [
			{ id: "a", name: "a", provider: "openai", modelId: "m", options: { openAiBaseUrl: "https://a.test/v1" } },
			{ id: "b", name: "b", provider: "openai", modelId: "", options: { openAiBaseUrl: "not a url" } },
		],
		actProfileId: "a",
		askProfileId: "a",
	})
	window.storage.secrets.set("profile:a:openAiApiKey", "sk-real")
}
const failing = () => {
	const secrets = new InMemoryConnectionSecretStore()
	const set = secrets.set.bind(secrets)
	secrets.set = async () => {
		throw new Error("store rejected sk-real")
	}
	return { secrets, restore: () => (secrets.set = set) }
}

describe("migration status", () => {
	it("publishes a redacted cause while nothing has moved, and retry completes it", async () => {
		const { secrets, restore } = failing()
		const window = openWindow(secrets)
		await seed(window)
		await window.manager.loadFromStorage()
		const failed = window.manager.getModelSettingsMigrationStatus()
		expect(failed).toMatchObject({ status: "failed", retryable: true, cause: "Could not write to the connection keychain" })
		expect(JSON.stringify(failed)).not.toContain("sk-real")
		expect(window.manager.getGlobalStateKey("modelSettingsMigration")?.status).not.toBe("complete")

		restore()
		await window.manager.retryModelSettingsMigration()
		const done = window.manager.getModelSettingsMigrationStatus()
		expect(done).toMatchObject({ status: "complete", retryable: false })
		expect(done.cause).toBeUndefined()
		expect(done.issues?.map((issue) => issue.field)).toEqual(["modelId", "baseUrl"])
		expect(JSON.stringify(done)).not.toContain("not a url")
		expect(window.manager.getGlobalStateKey("modelSettings")?.models).toHaveLength(2)
	})
	it("keeps legacy upkeep running after a failure", async () => {
		const { secrets } = failing()
		const window = openWindow(secrets)
		await seed(window)
		await window.storage.globalState.update("actProfileId", "gone")
		await window.manager.loadFromStorage()
		expect(window.manager.getModelSettingsMigrationStatus().status).toBe("failed")
		expect(window.manager.getGlobalStateKey("actProfileId")).toBe("a")
	})
	it("reports a settings lock timeout as retryable", async () => {
		const window = openWindow(new InMemoryConnectionSecretStore())
		await seed(window)
		const release = await acquireStorageLock(`${path.join(dir, "data", "globalState.json")}.lock`, { timeoutMs: 1000 })
		try {
			await (
				window.manager as unknown as { reconcileProfilesUnderLock(o: { timeoutMs: number }): Promise<void> }
			).reconcileProfilesUnderLock({ timeoutMs: 50 })
		} finally {
			release()
		}
		expect(window.manager.getModelSettingsMigrationStatus()).toMatchObject({ status: "failed", retryable: true })
		await window.manager.retryModelSettingsMigration()
		expect(window.manager.getModelSettingsMigrationStatus().status).toBe("complete")
	})
	it("reads a stored OpenRouter selection from the real store without the allowlist", async () => {
		const secrets = new InMemoryConnectionSecretStore()
		const window = openWindow(secrets)
		await window.storage.globalState.setBatch({ actModeApiProvider: "openrouter", actModeOpenRouterModelId: "or/m" })
		window.storage.secrets.set("openRouterApiKey", "sk-or")
		await window.manager.loadFromStorage()
		const [connection] = window.manager.getGlobalStateKey("modelSettings")?.connections ?? []
		expect(connection).toMatchObject({ kind: "provider", providerId: "openrouter" })
		expect(connection.auth.kind).toBe("keychain")
		if (connection.auth.kind === "keychain") expect(await secrets.get(connection.auth.secretRef)).toBe("sk-or")
	})
	it("does not re-read a corrupt SDK file once complete", async () => {
		const window = openWindow(new InMemoryConnectionSecretStore())
		await seed(window)
		await window.manager.loadFromStorage()
		fs.mkdirSync(path.join(window.storage.dataDir, "settings"), { recursive: true })
		fs.writeFileSync(path.join(window.storage.dataDir, "settings", "providers.json"), "{ corrupt")
		await window.manager.retryModelSettingsMigration()
		expect(window.manager.getModelSettingsMigrationStatus().status).toBe("complete")
	})
})
