import type { ApiConfiguration } from "@shared/api"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { EffectiveProviderConfig, ProviderCatalog, ProviderConfigStore } from "@/sdk/model-catalog/contracts"
import { computeConfigFingerprint } from "@/sdk/model-catalog/fingerprint"
import { parseProviderId } from "@/sdk/model-catalog/provider-id"
import { ApiFormat } from "@/shared/proto/cline/models"
import type { ProviderCatalogController } from "../providerCatalogShared"

type TestStateManager = {
	setGlobalStateBatch: ReturnType<typeof vi.fn>
	flushPendingState?: ReturnType<typeof vi.fn<() => Promise<void>>>
	getApiConfiguration?: ReturnType<typeof vi.fn<() => ApiConfiguration | undefined>>
}

function makeStore(config: EffectiveProviderConfig): ProviderConfigStore {
	return {
		read: vi.fn(() => config),
		readSelection: vi.fn(() => undefined),
		subscribe: vi.fn(() => ({ dispose: vi.fn() })),
		write: vi.fn(() => config),
		commitSelection: vi.fn(),
	}
}

function makeCatalog(): ProviderCatalog {
	return {
		listProviders: vi.fn(async () => []),
		invalidateProviderListings: vi.fn(),
		resolveModels: vi.fn(),
		peekModels: vi.fn(),
		subscribe: vi.fn(() => ({ dispose: vi.fn() })),
	}
}

function makeController(
	store: ProviderConfigStore,
	catalog: ProviderCatalog,
	stateManager?: TestStateManager,
	handleApiConfigurationChanged?: ReturnType<typeof vi.fn<(previous: ApiConfiguration, next: ApiConfiguration) => void>>,
): ProviderCatalogController {
	return {
		getProviderConfigStore: () => store,
		getProviderCatalog: () => catalog,
		...(stateManager ? { stateManager } : {}),
		...(handleApiConfigurationChanged ? { handleApiConfigurationChanged } : {}),
	}
}

describe("provider model catalog handlers", () => {
	afterEach(() => {
		vi.clearAllMocks()
	})

	it("listProviders returns provider listings from the catalog singleton", async () => {
		const { listProviders } = await import("../listProviders")
		const providerId = parseProviderId("deepseek")
		const store = makeStore({ providerId })
		const catalog = makeCatalog()
		vi.mocked(catalog.listProviders).mockResolvedValue([
			{
				id: providerId,
				name: "DeepSeek",
				defaultModelId: "deepseek-v4-flash",
				protocol: "openai-chat",
				authDescription: "DeepSeek models",
				allowsCustomModelIds: false,
				usageCostDisplay: "show",
			},
		])
		const controller = makeController(store, catalog)

		const response = await listProviders(controller, {})

		expect(response.providers).toEqual([
			{
				id: "deepseek",
				name: "DeepSeek",
				defaultModelId: "deepseek-v4-flash",
				family: undefined,
				protocol: "openai-chat",
				authDescription: "DeepSeek models",
				baseUrlDescription: undefined,
				allowsCustomModelIds: false,
				usageCostDisplay: "show",
			},
		])
		expect(catalog.listProviders).toHaveBeenCalledTimes(1)
	})

	it("resolveProviderModels returns full protobuf model metadata and request id", async () => {
		const { resolveProviderModels } = await import("../resolveProviderModels")
		const providerId = parseProviderId("deepseek")
		const fingerprint = computeConfigFingerprint(providerId, { providerId, apiKey: "secret" })
		const store = makeStore({ providerId, apiKey: "secret" })
		const catalog = makeCatalog()
		vi.mocked(catalog.resolveModels).mockResolvedValue({
			ok: true,
			providerId,
			configFingerprint: fingerprint,
			models: new Map([
				[
					"deepseek-v4-flash",
					{
						name: "DeepSeek V4 Flash",
						maxTokens: 123,
						contextWindow: 456,
						supportsImages: true,
						supportsPromptCache: true,
						supportsReasoning: true,
						inputPrice: 1,
						outputPrice: 2,
						cacheWritesPrice: 3,
						cacheReadsPrice: 4,
						description: "rich metadata",
						temperature: 0.2,
						apiFormat: ApiFormat.OPENAI_CHAT,
					},
				],
				[
					"whisper-large-v3",
					{
						name: "Whisper Large V3",
						supportsPromptCache: false,
						modalities: { input: ["audio"], output: ["text"] },
					},
				],
			]),
			defaultModelId: "whisper-large-v3",
			source: "sdk-dynamic",
			fetchedAt: 99,
		})
		const controller = makeController(store, catalog)

		const response = await resolveProviderModels(controller, {
			providerId: "deepseek",
			forceRefresh: true,
			requestId: "req-1",
		})

		expect(response.requestId).toBe("req-1")
		expect(response.configFingerprint).toBe(fingerprint)
		expect(response.models["deepseek-v4-flash"]).toMatchObject({
			name: "DeepSeek V4 Flash",
			maxTokens: 123,
			contextWindow: 456,
			supportsImages: true,
			supportsPromptCache: true,
			supportsReasoning: true,
			temperature: 0.2,
			apiFormat: ApiFormat.OPENAI_CHAT,
		})
		expect(response.models["whisper-large-v3"]).toBeUndefined()
		// Do not invent an order-dependent default when the declared default is
		// filtered out. The picker can leave the selection unset instead.
		expect(response.defaultModelId).toBeUndefined()
		expect(catalog.resolveModels).toHaveBeenCalledWith(providerId, { forceRefresh: true })
	})

	// The settings UI sources provider ids from the SDK catalog, whose OpenAI
	// Compatible built-in is spelled `openai-compatible`. Committing under that
	// spelling must land on the legacy `openai` state keys
	// (`actModeApiProvider` / `actModeOpenAiModelId`), otherwise the chat view
	// and session factory (both keyed by `openai`) read stale or default
	// models (gpt-4o) instead of the user's selection.
	// The model label under the chat input renders from pushed extension
	// state; a model-only commit must push state itself instead of waiting
	// for an unrelated action (e.g. sending a message) to refresh it.
	// The overrides field is tri-state: absent preserves the model's stored
	// overrides, an explicitly empty message clears them, and a populated
	// message replaces them. The two boundary cases are pinned here because
	// the webview relies on both (see useProviderConfig.test.ts).
})
