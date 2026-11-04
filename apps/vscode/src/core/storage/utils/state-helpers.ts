import { ApiProvider } from "@shared/api"
import { createDefaultModelSettings } from "@shared/model-settings"
import type { ClineFileStorage } from "@shared/storage/ClineFileStorage"
import {
	applyTransform,
	GlobalStateAndSettingKeys,
	GlobalStateAndSettings,
	getDefaultValue,
	isAsyncProperty,
	isComputedProperty,
	LocalState,
	LocalStateKeys,
	SecretKeys,
	Secrets,
} from "@shared/storage/state-keys"
import { modelSettingsRolloutEnabled } from "@/sdk/model-settings/rollout"
import { Logger } from "@/shared/services/Logger"
import { ClineMemento } from "@/shared/storage"
import { StateManager } from "../StateManager"

// ─── File-backed storage readers (used by StateManager) ────────────────────

/**
 * Read secrets from a ClineFileStorage instance.
 */
export function readSecretsFromStorage(store: ClineFileStorage<string>): Secrets {
	return SecretKeys.reduce((acc, key) => {
		acc[key] = store.get(key)
		return acc
	}, {} as Secrets)
}

/**
 * Read workspace state from a ClineFileStorage instance.
 */
export function readWorkspaceStateFromStorage(store: ClineFileStorage): LocalState {
	return LocalStateKeys.reduce((acc, key) => {
		acc[key] = store.get(key) || {}
		return acc
	}, {} as LocalState)
}

/**
 * Read global state from a ClineFileStorage instance.
 */
export async function readGlobalStateFromStorage(store: ClineMemento): Promise<GlobalStateAndSettings> {
	try {
		// Batch read all state values in a single optimized pass
		const stateValues = new Map<string, any>()
		for (const key of GlobalStateAndSettingKeys) {
			const value = store.get(key as string)
			stateValues.set(key, value)
		}

		const result = {} as any

		for (const key of GlobalStateAndSettingKeys) {
			const stateKey = key as keyof GlobalStateAndSettings
			let value = stateValues.get(stateKey)

			if (isAsyncProperty(stateKey)) {
				continue
			}
			if (isComputedProperty(stateKey)) {
				continue
			}
			if (value === undefined) {
				const defaultValue = getDefaultValue(stateKey)
				if (defaultValue !== undefined) {
					value = defaultValue
				}
			}
			if (value !== undefined) {
				value = applyTransform(stateKey, value)
			}
			result[stateKey] = value
		}

		await handleComputedProperties(result, stateValues)

		return result as GlobalStateAndSettings
	} catch (error) {
		Logger.error("[StateHelpers] Failed to read global state from storage:", error)
		throw error
	}
}

// ─── Legacy readers (for VSCode migration — reads from ExtensionContext) ────

/**
 * Handle properties that require computed logic
 */
async function handleComputedProperties(result: any, stateValues: Map<string, any>): Promise<void> {
	// 1. API Provider logic - set defaults based on existing values
	const defaultApiProvider: ApiProvider = "openrouter"
	result.planModeApiProvider = result.planModeApiProvider || defaultApiProvider
	result.actModeApiProvider = result.actModeApiProvider || defaultApiProvider

	// 2. Plan/Act separate models setting with special logic
	const planActSeparateModelsSettingRaw = stateValues.get("planActSeparateModelsSetting")
	if (planActSeparateModelsSettingRaw === true || planActSeparateModelsSettingRaw === false) {
		result.planActSeparateModelsSetting = planActSeparateModelsSettingRaw
	} else {
		// Default to false when not explicitly set
		result.planActSeparateModelsSetting = false
	}
}

export async function resetWorkspaceState() {
	const stateManager = StateManager.get()
	LocalStateKeys.map((key) => stateManager.setWorkspaceState(key, {}))
	await stateManager.reInitialize()
}

export async function resetGlobalState() {
	// TODO: Reset all workspace states?
	const stateManager = StateManager.get()
	const { connectionSecretRefs, forgetModelSettingsSnapshot } = await import("@/sdk/model-settings/host-settings")
	const store = stateManager.connectionSecrets
	if (store) {
		// Keys go first: if the keychain refuses, the settings that name them are still there to retry from.
		const named = stateManager.getGlobalStateKey("modelSettings")?.connections.flatMap(connectionSecretRefs) ?? []
		for (const ref of new Set([...named, ...(await store.list())])) await store.delete(ref)
	}
	// Saved configurations keep their own copies under this prefix, which no named key covers.
	const profileSecrets = stateManager.listSecretStorageKeys().filter((key) => key.startsWith("profile:"))
	await stateManager.setSecretsForKeys(Object.fromEntries(profileSecrets.map((key) => [key, undefined])))
	forgetModelSettingsSnapshot(stateManager)
	GlobalStateAndSettingKeys.map((key) => stateManager.setGlobalState(key, undefined))
	SecretKeys.map((key) => stateManager.setSecret(key, undefined))
	// The move has nothing left to do, and running it again would bring back what the shared stores hold.
	if (modelSettingsRolloutEnabled()) {
		stateManager.setGlobalState("modelSettings", createDefaultModelSettings())
		stateManager.setGlobalState("modelSettingsMigration", {
			version: 1,
			status: "complete",
			backupId: "settings-reset",
			configurationModels: {},
			profilePicks: {},
			legacyFingerprint: "settings-reset",
			completedAt: Date.now(),
		})
	}
	await stateManager.reInitialize()
}
