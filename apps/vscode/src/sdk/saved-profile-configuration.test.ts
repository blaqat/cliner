import type { ApiConfigProfile } from "@shared/api-profiles"
import { describe, expect, it, vi } from "vitest"
import { type ApiProfileStore, snapshotApiProfileConfiguration } from "@/core/controller/models/apiProfiles"
import { buildSdkProviderConfig } from "./sdk-api-handler"

vi.mock("./provider-migration", () => ({
	getProviderSettingsManager: () => ({
		getProviderSettings: () => ({
			apiKey: "stored-key",
			baseUrl: "https://stored/v1",
			azure: { apiVersion: "stored-version" },
		}),
	}),
}))

function profileStore() {
	const profiles: ApiConfigProfile[] = [
		{
			id: "a",
			name: "A",
			provider: "openai",
			modelId: "ask",
			openAiCompatibleApiType: "chat",
			options: { openAiBaseUrl: "https://a/v1", openAiHeaders: { Authorization: "header-a" } },
		},
		{
			id: "b",
			name: "B",
			provider: "openai",
			modelId: "act",
			openAiCompatibleApiType: "responses",
			options: { openAiBaseUrl: "https://b/v1", openAiHeaders: { Authorization: "header-b" } },
		},
	]
	const state = { apiConfigProfiles: profiles, askProfileId: "a", actProfileId: "b" }
	const secrets: Record<string, string> = { "profile:a:openAiApiKey": "key-a", "profile:b:openAiApiKey": "key-b" }
	return {
		profiles,
		secrets,
		store: {
			getGlobalStateKey: (key: keyof typeof state) => state[key],
			listSecretStorageKeys: () => Object.keys(secrets),
			getSecretForKey: (key: string) => secrets[key],
		} as unknown as ApiProfileStore,
	}
}

describe("saved profiles in provider handlers", () => {
	it("builds Ask and Act URL/key/headers/protocol from their own assigned profiles", () => {
		const { store } = profileStore()
		const snapshot = snapshotApiProfileConfiguration(store, {}, "act")
		const ask = buildSdkProviderConfig(snapshot, "plan")
		const act = buildSdkProviderConfig(snapshot, "act")
		expect(ask).toMatchObject({
			modelId: "ask",
			apiKey: "key-a",
			baseUrl: "https://a/v1",
			headers: { Authorization: "header-a" },
		})
		expect(ask.routingProviderId).toBeUndefined()
		expect(act).toMatchObject({
			modelId: "act",
			apiKey: "key-b",
			baseUrl: "https://b/v1",
			headers: { Authorization: "header-b" },
			routingProviderId: "openai-native",
		})
	})

	it("does not inherit credentials, endpoint, headers or Azure options when omitted", () => {
		const { store, profiles, secrets } = profileStore()
		profiles[0].options = undefined
		delete secrets["profile:a:openAiApiKey"]
		const snapshot = snapshotApiProfileConfiguration(
			store,
			{ openAiApiKey: "legacy-key", openAiBaseUrl: "https://legacy/v1" },
			"plan",
		)
		const config = buildSdkProviderConfig(snapshot, "plan")
		expect(config.apiKey).toBe("")
		expect(config.baseUrl).toBeUndefined()
		expect(config.headers).toEqual({})
		expect(config.azure?.apiVersion).toBeUndefined()
	})
})
