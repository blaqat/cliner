import { describe, expect, it } from "bun:test"
import type { ApiConfiguration } from "@shared/api"
import { ALLOWED_API_PROVIDERS, isAllowedApiProvider, toAllowedApiProvider } from "@shared/api-profiles"
import { isSecretKey } from "@shared/storage/state-keys"
import {
	type ApiProfileStore,
	assignApiConfigProfile,
	deleteApiConfigProfile,
	ensureApiConfigProfiles,
	listProfileSecretKeys,
	profileSecretStorageKey,
	readApiConfigProfiles,
	resolveApiConfigurationForMode,
	snapshotApiProfileConfiguration,
	upsertApiConfigProfile,
} from "../apiProfiles"

function createStore(config: Partial<ApiConfiguration> = {}) {
	const globalState: Record<string, unknown> = {}
	const secretsStore: Record<string, string> = {}
	// Fake ApiConfiguration: secrets and settings merged into one object,
	// mirroring StateManager.constructApiConfigurationFromCache.
	const apiConfig: Record<string, unknown> = { ...config }

	const store: ApiProfileStore = {
		getGlobalStateKey: ((key: string) => globalState[key]) as ApiProfileStore["getGlobalStateKey"],
		setGlobalStateBatch: (updates) => {
			Object.assign(globalState, updates)
		},
		getApiConfiguration: () => apiConfig as ApiConfiguration,
		setApiConfiguration: (updates) => {
			for (const [key, value] of Object.entries(updates)) {
				if (value !== undefined) {
					apiConfig[key] = value
				}
			}
		},
		getSecretForKey: (key) => secretsStore[key],
		setSecretsForKeys: (entries) => {
			for (const [key, value] of Object.entries(entries)) {
				if (value === undefined || value === "") {
					delete secretsStore[key]
				} else {
					secretsStore[key] = value
				}
			}
		},
		listSecretStorageKeys: () => Object.keys(secretsStore),
	}
	return { store, globalState, secretsStore, apiConfig }
}

describe("provider allowlist", () => {
	it("keeps allowed providers", () => {
		for (const provider of ALLOWED_API_PROVIDERS) {
			expect(toAllowedApiProvider(provider)).toBe(provider)
		}
		expect(isAllowedApiProvider("bedrock")).toBe(true)
	})

	it("maps a stored disallowed provider to the first allowed one", () => {
		expect(toAllowedApiProvider("openrouter")).toBe(ALLOWED_API_PROVIDERS[0])
		expect(toAllowedApiProvider("cline")).toBe(ALLOWED_API_PROVIDERS[0])
		expect(toAllowedApiProvider(undefined)).toBe(ALLOWED_API_PROVIDERS[0])
	})
})

describe("upsertApiConfigProfile", () => {
	it("creates a profile and stores secrets under the profile scope", () => {
		const { store, secretsStore } = createStore()
		const profile = upsertApiConfigProfile(store, {
			name: "Local vLLM",
			provider: "openai",
			modelId: "gpt-5.5",
			openAiCompatibleApiType: "responses",
			options: { openAiBaseUrl: "http://localhost:8000/v1" },
			secrets: { openAiApiKey: "sk-test" },
		})

		expect(profile.id).toBeTruthy()
		expect(readApiConfigProfiles(store)).toEqual([profile])
		expect(secretsStore[profileSecretStorageKey(profile.id, "openAiApiKey")]).toBe("sk-test")
		expect(listProfileSecretKeys(store, profile.id)).toEqual(["openAiApiKey"])
	})

	it("sanitizes options: drops secret keys and unknown settings keys", () => {
		const { store } = createStore()
		const profile = upsertApiConfigProfile(store, {
			name: "x",
			provider: "anthropic",
			modelId: "m",
			options: {
				anthropicBaseUrl: "https://example.com",
				apiKey: "should-not-be-stored-here",
				notARealKey: 1,
			} as Record<string, unknown>,
		})
		expect(profile.options).toEqual({ anthropicBaseUrl: "https://example.com" })
	})

	it("repairs missing assignments at save without waiting for serialization", () => {
		const { store, globalState } = createStore()
		const first = upsertApiConfigProfile(store, { name: "A", provider: "openai", modelId: "a" })
		globalState.askProfileId = "missing"
		globalState.actProfileId = undefined
		upsertApiConfigProfile(store, { name: "B", provider: "openai", modelId: "b" })
		expect(globalState.askProfileId).toBe(first.id)
		expect(globalState.actProfileId).toBe(first.id)
		expect(store.getApiConfiguration().planModeOpenAiModelId).toBe("a")
		expect(store.getApiConfiguration().actModeOpenAiModelId).toBe("a")
	})

	it("updates an existing profile in place and preserves stored secrets when none are sent", () => {
		const { store, secretsStore } = createStore()
		const created = upsertApiConfigProfile(store, {
			name: "a",
			provider: "anthropic",
			modelId: "claude-1",
			secrets: { apiKey: "k1" },
		})
		const updated = upsertApiConfigProfile(store, {
			id: created.id,
			name: "b",
			provider: "anthropic",
			modelId: "claude-2",
		})
		expect(updated.id).toBe(created.id)
		expect(readApiConfigProfiles(store)).toHaveLength(1)
		expect(readApiConfigProfiles(store)[0].modelId).toBe("claude-2")
		expect(secretsStore[profileSecretStorageKey(created.id, "apiKey")]).toBe("k1")
	})
})

describe("assignApiConfigProfile", () => {
	it("writes provider, model, options and secrets into the mode's keys", () => {
		const { store, apiConfig: legacyConfig } = createStore()
		const profile = upsertApiConfigProfile(store, {
			name: "Local vLLM",
			provider: "openai",
			modelId: "gpt-5.6",
			openAiCompatibleApiType: "responses",
			options: { openAiBaseUrl: "http://localhost:8000/v1" },
			secrets: { openAiApiKey: "sk-xyz" },
		})

		assignApiConfigProfile(store, "act", profile.id)
		const apiConfig = snapshotApiProfileConfiguration(store, legacyConfig as ApiConfiguration, "act")

		expect(apiConfig.actModeApiProvider).toBe("openai")
		expect(apiConfig.actModeOpenAiModelId).toBe("gpt-5.6")
		expect(apiConfig.openAiBaseUrl).toBe("http://localhost:8000/v1")
		expect(apiConfig.openAiCompatibleApiType).toBe("responses")
		expect(apiConfig.openAiApiKey).toBe("sk-xyz")
		expect(store.getGlobalStateKey("actProfileId")).toBe(profile.id)
	})

	it("remaps mode-prefixed options onto the assigned mode", () => {
		const { store, apiConfig } = createStore()
		const profile = upsertApiConfigProfile(store, {
			name: "x",
			provider: "openai",
			modelId: "m",
			options: { planModeOpenAiModelInfo: { contextWindow: 1000 } },
		})

		const askInfo = apiConfig.planModeOpenAiModelInfo
		assignApiConfigProfile(store, "act", profile.id)
		expect(apiConfig.actModeOpenAiModelInfo).toEqual({ contextWindow: 1000 })
		expect(apiConfig.planModeOpenAiModelInfo).toEqual(askInfo)
	})

	it("throws when the profile does not exist", () => {
		const { store } = createStore()
		expect(() => assignApiConfigProfile(store, "act", "missing")).toThrow()
	})
})

describe("deleteApiConfigProfile", () => {
	it("removes the profile and secrets and assigns the replacement before returning", () => {
		const { store, secretsStore } = createStore()
		const profile = upsertApiConfigProfile(store, {
			name: "a",
			provider: "anthropic",
			modelId: "m",
			secrets: { apiKey: "k" },
		})
		assignApiConfigProfile(store, "plan", profile.id)
		const replacement = upsertApiConfigProfile(store, { name: "b", provider: "anthropic", modelId: "replacement" })

		expect(deleteApiConfigProfile(store, profile.id)).toBe(true)
		expect(readApiConfigProfiles(store)).toEqual([replacement])
		expect(listProfileSecretKeys(store, profile.id)).toEqual([])
		expect(secretsStore[profileSecretStorageKey(profile.id, "apiKey")]).toBeUndefined()
		expect(store.getGlobalStateKey("askProfileId")).toBe(replacement.id)
		expect(store.getGlobalStateKey("actProfileId")).toBe(replacement.id)
		expect(store.getApiConfiguration().planModeApiModelId).toBe("replacement")
	})

	it("rejects deleting the last profile without changing assignments or secrets", () => {
		const { store, globalState, secretsStore } = createStore()
		const profile = upsertApiConfigProfile(store, {
			name: "a",
			provider: "anthropic",
			modelId: "m",
			secrets: { apiKey: "key" },
		})
		const before = { ...globalState }
		expect(() => deleteApiConfigProfile(store, profile.id)).toThrow("Cannot delete the last saved configuration")
		expect(globalState).toEqual(before)
		expect(secretsStore[profileSecretStorageKey(profile.id, "apiKey")]).toBe("key")
	})

	it("returns false for unknown ids", () => {
		const { store } = createStore()
		expect(deleteApiConfigProfile(store, "nope")).toBe(false)
	})
})

describe("ensureApiConfigProfiles (migration)", () => {
	it("creates one profile per mode and assigns them", () => {
		const { store } = createStore({
			planModeApiProvider: "anthropic",
			planModeApiModelId: "claude-ask",
			actModeApiProvider: "openai",
			actModeOpenAiModelId: "gpt-local",
			openAiBaseUrl: "http://localhost:8000/v1",
			openAiCompatibleApiType: "responses",
		})

		const { profiles, askProfileId, actProfileId } = ensureApiConfigProfiles(store)
		expect(profiles).toHaveLength(2)

		const ask = profiles.find((p) => p.id === askProfileId)
		const act = profiles.find((p) => p.id === actProfileId)
		expect(ask).toBeDefined()
		expect(act).toBeDefined()
		expect(ask?.provider).toBe("anthropic")
		expect(ask?.modelId).toBe("claude-ask")
		expect(act?.provider).toBe("openai")
		expect(act?.modelId).toBe("gpt-local")
		expect(act?.openAiCompatibleApiType).toBe("responses")
		expect(act?.options?.openAiBaseUrl).toBe("http://localhost:8000/v1")
	})

	it("dedupes identical mode configurations into a single profile", () => {
		const { store } = createStore({
			planModeApiProvider: "anthropic",
			planModeApiModelId: "claude-1",
			actModeApiProvider: "anthropic",
			actModeApiModelId: "claude-1",
			apiKey: "shared-key",
		})

		const { profiles, askProfileId, actProfileId } = ensureApiConfigProfiles(store)
		expect(profiles).toHaveLength(1)
		expect(askProfileId).toBe(profiles[0].id)
		expect(actProfileId).toBe(profiles[0].id)
		// The shared secret is copied into the profile scope.
		expect(store.getSecretForKey(profileSecretStorageKey(profiles[0].id, "apiKey"))).toBe("shared-key")
	})

	it("is a no-op when profiles already exist", () => {
		const { store } = createStore()
		const profile = upsertApiConfigProfile(store, { name: "x", provider: "bedrock", modelId: "m" })
		const first = ensureApiConfigProfiles(store)
		expect(first.profiles).toEqual([profile])
		expect(first.actProfileId).toBe(profile.id)
	})
})

describe("isolated profile configuration", () => {
	it("clears credentials, headers and omitted connection options on reassignment", () => {
		const { store, apiConfig } = createStore({ openAiApiKey: "legacy-key", awsRegion: "legacy-region", azureIdentity: true })
		const a = upsertApiConfigProfile(store, {
			name: "A",
			provider: "openai",
			modelId: "a",
			options: { openAiBaseUrl: "https://a/v1", openAiHeaders: { Authorization: "secret-a" } },
			secrets: { openAiApiKey: "key-a" },
		})
		const b = upsertApiConfigProfile(store, {
			name: "B",
			provider: "openai",
			modelId: "b",
			options: { openAiBaseUrl: "https://b/v1" },
		})
		assignApiConfigProfile(store, "act", a.id)
		assignApiConfigProfile(store, "act", b.id)
		const config = snapshotApiProfileConfiguration(store, apiConfig as ApiConfiguration, "act")
		expect(config.openAiBaseUrl).toBe("https://b/v1")
		expect(config.openAiApiKey).toBeUndefined()
		expect(config.openAiHeaders).toBeUndefined()
		expect(config.azureIdentity).toBeUndefined()
		expect(config.awsRegion).toBeUndefined()
	})

	it("resolves Ask and Act independently and re-resolves edits on mode switches", () => {
		const { store, apiConfig } = createStore()
		const a = upsertApiConfigProfile(store, {
			name: "A",
			provider: "openai",
			modelId: "ask",
			openAiCompatibleApiType: "chat",
			options: { openAiBaseUrl: "https://a/v1" },
			secrets: { openAiApiKey: "key-a" },
		})
		const b = upsertApiConfigProfile(store, {
			name: "B",
			provider: "openai",
			modelId: "act",
			openAiCompatibleApiType: "responses",
			options: { openAiBaseUrl: "https://b/v1" },
			secrets: { openAiApiKey: "key-b" },
		})
		assignApiConfigProfile(store, "plan", a.id)
		assignApiConfigProfile(store, "act", b.id)
		const ask = snapshotApiProfileConfiguration(store, apiConfig as ApiConfiguration, "plan")
		const act = resolveApiConfigurationForMode(ask, "act")
		expect([ask.openAiBaseUrl, ask.openAiApiKey, ask.openAiCompatibleApiType]).toEqual(["https://a/v1", "key-a", "chat"])
		expect([act.openAiBaseUrl, act.openAiApiKey, act.openAiCompatibleApiType]).toEqual(["https://b/v1", "key-b", "responses"])
		upsertApiConfigProfile(store, {
			id: a.id,
			name: "A",
			provider: "openai",
			modelId: "new-ask",
			options: { openAiBaseUrl: "https://new-a/v1" },
			secrets: { openAiApiKey: "new-key" },
		})
		const switched = snapshotApiProfileConfiguration(store, apiConfig as ApiConfiguration, "plan")
		expect(switched.planModeOpenAiModelId).toBe("new-ask")
		expect(switched.openAiApiKey).toBe("new-key")
		expect(ask.openAiApiKey).toBe("key-a")
		expect(resolveApiConfigurationForMode(switched, "act").openAiApiKey).toBe("key-b")
	})
})

describe("isSecretKey sanity", () => {
	it("treats profile secret field names as ApiConfiguration secrets", () => {
		expect(isSecretKey("openAiApiKey")).toBe(true)
	})
})
