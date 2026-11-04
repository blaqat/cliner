import { createHandler } from "@cline/llms"
import type { ModelSettings } from "@shared/model-settings"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { buildApiConfigurationFromProfile } from "@/core/controller/models/apiProfiles"
import { migrateModelSettings } from "@/core/storage/model-settings-migration"
import { buildSdkProviderConfig } from "@/sdk/sdk-api-handler"
import { resolveConfiguredPick } from "../model-settings-resolver"
import { modelAuthDependencies } from "./auth-dependencies"
import { InMemoryConnectionSecretStore } from "./connection-secret-store"
import { catalogModelValues, catalogReasoningLevels, rememberDetectedModelMetadata } from "./host-settings"
import { configuredProviderConfig, requestPolicyGuard } from "./runtime-config"

const transport = vi.hoisted(() => vi.fn())
vi.mock("@/shared/net", () => ({ fetch: transport }))
vi.mock("./rollout", () => ({ MODEL_SETTINGS_ROLLOUT_ENABLED: true, modelSettingsRolloutEnabled: () => true }))
vi.mock("@/shared/services/Logger", () => ({
	Logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() },
}))

beforeEach(() => {
	transport.mockReset()
	transport.mockImplementation(
		async () =>
			new Response(JSON.stringify({ error: { message: "test rejection" } }), {
				status: 400,
				headers: { "content-type": "application/json" },
			}),
	)
})

type Seed = Record<string, unknown>
async function migrated(seed: Seed, keys: Record<string, string> = {}, sdkInput: Seed = {}) {
	const data: Record<string, any> = structuredClone(seed)
	const secrets = new InMemoryConnectionSecretStore()
	const state = {
		keys: () => Object.keys(data),
		get: (k: string) => structuredClone(data[k]),
		update: async (k: string, v: unknown) => {
			data[k] = structuredClone(v)
		},
	}
	await migrateModelSettings({
		state: state as never,
		secrets,
		legacySecretKeys: Object.keys(keys),
		readLegacySecret: (k) => keys[k],
		sdkInput,
	})
	const settings = data.modelSettings as ModelSettings
	const remote: Record<string, unknown> = {}
	const store = {
		connectionSecrets: secrets,
		getGlobalStateKey: (k: string) => data[k],
		getGlobalSettingsKey: (k: string) => data[k],
		getRemoteConfigSettings: () => remote,
		getModelSettingsMigrationStatus: () => ({ status: "complete", retryable: false }),
		getSecretKey: () => undefined,
	} as never
	const build = (pick = settings.roles.chat) =>
		configuredProviderConfig(settings, pick, modelAuthDependencies(store), { state: store, mode: "act" })
	return {
		data,
		settings,
		secrets,
		store,
		remote,
		build,
		issues: (data.modelSettingsMigration.issues ?? []) as Array<Record<string, string>>,
		rows: () => settings.models.map((m) => m.upstreamId),
		rowOf: (upstreamId: string) => settings.models.find((m) => m.upstreamId === upstreamId)!,
		values: (upstreamId: string) => {
			const row = settings.models.find((m) => m.upstreamId === upstreamId)!
			return resolveConfiguredPick(settings, { modelId: row.id, levelId: "default" }).values
		},
	}
}
/** A real handler, up to the HTTP boundary. */
async function wire(config: Parameters<typeof createHandler>[0]) {
	transport.mockClear()
	try {
		for await (const _chunk of createHandler(config).createMessage("System", [{ role: "user", content: "Hello" }])) {
			/* drain */
		}
	} catch {
		/* The rejection above is intentional. */
	}
	const [url, init] = (transport.mock.calls[0] ?? []) as unknown as [string, RequestInit]
	return init
		? { url: String(url), headers: new Headers(init.headers), body: JSON.parse(String(init.body)) }
		: { url: undefined, headers: new Headers(), body: undefined as any }
}
const profile = (id: string, modelId: string, options: Seed = {}, extra: Seed = {}) => ({
	id,
	name: id,
	provider: "openai",
	modelId,
	options: { openAiBaseUrl: "https://ai.acme.example/v1", ...options },
	...extra,
})
const assign = (id: string) => ({ actProfileId: id, askProfileId: id })

describe("B1: model info as the editor saves it", () => {
	const info = {
		contextWindow: 400_000,
		maxTokens: 9000,
		temperature: 0.7,
		supportsImages: false,
		inputPrice: 3,
		outputPrice: 15,
		cacheReadsPrice: 0.3,
		cacheWritesPrice: 3.75,
	}
	const expected = {
		contextWindow: 400_000,
		maxOutputTokens: 9000,
		temperature: 0.7,
		images: "no",
		inputPrice: 3,
		outputPrice: 15,
		cacheReadPrice: 0.3,
		cacheWritePrice: 3.75,
	}
	it.each(["planMode", "actMode"])("keeps every field saved under %s, with no issue", async (prefix) => {
		const f = await migrated(
			{ apiConfigProfiles: [profile("p", "m", { [`${prefix}OpenAiModelInfo`]: info })], ...assign("p") },
			{ "profile:p:openAiApiKey": "K" },
		)
		expect(f.values("m")).toMatchObject(expected)
		expect(f.rowOf("m").legacyMetadata?.modelInfo).toMatchObject({ contextWindow: 400_000, maxTokens: 9000 })
		expect(f.issues).toEqual([])
		const config = await f.build()
		expect(config.knownModels?.m).toMatchObject({
			contextWindow: 400_000,
			maxTokens: 9000,
			pricing: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		})
		expect(config.knownModels?.m.capabilities).not.toContain("images")
		const { body } = await wire(config)
		expect(body).toMatchObject({ max_tokens: 9000, temperature: 0.7 })
	})
	it("survives lifting shared values to a grouped connection", async () => {
		const shared = { planModeOpenAiModelInfo: info }
		const f = await migrated(
			{ apiConfigProfiles: [profile("p", "a", shared), profile("q", "b", shared)], ...assign("p") },
			{ "profile:p:openAiApiKey": "K", "profile:q:openAiApiKey": "K" },
		)
		expect(f.settings.connections).toHaveLength(1)
		expect(f.values("a")).toMatchObject(expected)
		expect(f.values("b")).toMatchObject(expected)
	})
	it("builds from the safe defaults the editor starts from", async () => {
		const safeDefaults = {
			maxTokens: -1,
			contextWindow: 128_000,
			supportsImages: true,
			supportsPromptCache: false,
			inputPrice: 0,
			outputPrice: 0,
			temperature: 0,
		}
		const f = await migrated(
			{ apiConfigProfiles: [profile("p", "m", { planModeOpenAiModelInfo: safeDefaults })], ...assign("p") },
			{ "profile:p:openAiApiKey": "K" },
		)
		expect(f.issues).toEqual([])
		expect(f.values("m")).toMatchObject({ contextWindow: 128_000, images: "yes", temperature: 0 })
		await expect(f.build()).resolves.toBeDefined()
	})
	it("keeps a Bedrock custom model captured in Ask", async () => {
		const f = await migrated(
			{
				apiConfigProfiles: [
					{
						id: "b",
						name: "b",
						provider: "bedrock",
						modelId: "arn:aws:bedrock:us-east-1:1:foo",
						options: {
							awsRegion: "us-east-1",
							planModeAwsBedrockCustomSelected: true,
							planModeAwsBedrockCustomModelBaseId: "anthropic.claude-opus-4-5-20251101-v1:0",
						},
					},
				],
				...assign("b"),
			},
			{ "profile:b:awsAccessKey": "A", "profile:b:awsSecretKey": "S" },
		)
		const row = f.rowOf("arn:aws:bedrock:us-east-1:1:foo")
		expect(row.providerOptions).toMatchObject({
			actModeAwsBedrockCustomSelected: true,
			actModeAwsBedrockCustomModelBaseId: "anthropic.claude-opus-4-5-20251101-v1:0",
		})
		expect((await f.build()).aws?.customModelBaseId).toBe("anthropic.claude-opus-4-5-20251101-v1:0")
	})
	it("a flat row reads only its own mode and its own provider's info", async () => {
		const f = await migrated(
			{
				actModeApiProvider: "openai",
				planModeApiProvider: "openai",
				actModeOpenAiModelId: "same",
				planModeOpenAiModelId: "same",
				openAiBaseUrl: "https://ai.acme.example/v1",
				actModeOpenRouterModelInfo: { contextWindow: 1 },
				actModeOpenAiModelInfo: { contextWindow: 2000 },
				planModeOpenAiModelInfo: { contextWindow: 3000 },
			},
			{ openAiApiKey: "K" },
		)
		const contexts = f.settings.models.map(
			(m) => resolveConfiguredPick(f.settings, { modelId: m.id, levelId: "default" }).values.contextWindow,
		)
		expect(contexts.sort()).toEqual([2000, 3000])
	})
})

describe("B3: a budget with no upper limit", () => {
	const sonnet = "claude-sonnet-4-5-20250929"
	const native = (provider: string, modelId: string, options: Seed, effort: string) => ({
		apiConfigProfiles: [{ id: "p", name: "p", provider, modelId, options }],
		...assign("p"),
		actModeReasoningEffort: effort,
		planModeReasoningEffort: effort,
	})
	/** Sent through the legacy path, the comparison this has to match. */
	const legacyWire = (seed: ReturnType<typeof native>, secrets: Record<string, string>, effort: string) =>
		wire({
			...buildSdkProviderConfig(
				{
					...buildApiConfigurationFromProfile(seed.apiConfigProfiles[0] as never, secrets, "act", false),
					actModeReasoningEffort: effort,
				} as never,
				"act",
			),
			fetch: transport,
		} as never)

	it("offers low, medium and high as efforts", () => {
		const levels = catalogReasoningLevels({
			capabilities: ["reasoning"],
			reasoningOptions: [{ type: "toggle" }, { type: "budget_tokens", min: 1024 }],
		})
		expect(levels?.map((l) => [l.id, l.request.kind])).toEqual([
			["default", "default"],
			["low", "effort"],
			["medium", "effort"],
			["high", "effort"],
		])
		expect(catalogReasoningLevels({ capabilities: ["reasoning"], reasoningOptions: [{ type: "toggle" }] })).toBeUndefined()
	})
	it.each(["low", "medium", "high"])("Sonnet 4.5 at %s sends the budget legacy sends", async (effort) => {
		const seed = native("anthropic", sonnet, { anthropicBaseUrl: "https://wire.test/v1" }, effort)
		const f = await migrated(seed, { "profile:p:apiKey": "K" })
		expect(f.settings.roles.chat?.levelId).toBe(effort)
		expect(f.issues).toEqual([])
		const { body } = await wire(await f.build())
		const legacy = await legacyWire(seed, { apiKey: "K" }, effort)
		expect(legacy.body.thinking?.budget_tokens).toBeGreaterThan(0)
		expect(body.thinking).toEqual(legacy.body.thinking)
	})
	it("Sonnet 4.5 at high sends 38400", async () => {
		const f = await migrated(native("anthropic", sonnet, { anthropicBaseUrl: "https://wire.test/v1" }, "high"), {
			"profile:p:apiKey": "K",
		})
		expect((await wire(await f.build())).body.thinking).toEqual({ type: "enabled", budget_tokens: 38400 })
	})
	it("Bedrock's Sonnet 4.5 at high keeps its thinking", async () => {
		const id = "anthropic.claude-sonnet-4-5-20250929-v1:0"
		const seed = native("bedrock", id, { awsRegion: "us-east-1", awsBedrockEndpoint: "https://wire.test" }, "high")
		const f = await migrated(seed, { "profile:p:awsAccessKey": "A", "profile:p:awsSecretKey": "S" })
		expect(f.settings.roles.chat?.levelId).toBe("high")
		const { body } = await wire(await f.build())
		expect(body.additionalModelRequestFields?.thinking).toEqual({ type: "enabled", budget_tokens: 38400 })
	})
	it("a fresh row offers high, so onboarding accepts it", () => {
		const row = { id: "r", connectionId: "c", upstreamId: sonnet, name: "", kind: "chat", overrides: {}, providerOptions: {} }
		const connection = { id: "c", kind: "provider", providerId: "anthropic" }
		const values = catalogModelValues(row as never, connection as never)
		expect(values.levels?.map((l) => l.id)).toContain("high")
		expect(values.reasoning).toBe("yes")
	})
	it("records an issue whenever a saved level is lowered", async () => {
		const f = await migrated(native("anthropic", sonnet, {}, "xhigh"), { "profile:p:apiKey": "K" })
		expect(f.settings.roles.chat?.levelId).toBe("high")
		expect(f.issues).toEqual([expect.objectContaining({ kind: "normalized", field: "level", modelId: f.rowOf(sonnet).id })])
	})
	it("a profile's lowered level records one too", async () => {
		const f = await migrated(
			{
				apiConfigProfiles: [{ id: "c", name: "Sonnet", provider: "anthropic", modelId: sonnet, options: {} }],
				profiles: [{ id: "pf", name: "Deep", configurationId: "c", reasoningEffort: "max" }],
				threadDefaultProfileId: "pf",
				...assign("c"),
			},
			{ "profile:c:apiKey": "K" },
		)
		expect(f.settings.roles.chat?.levelId).toBe("high")
		expect(f.issues).toEqual([expect.objectContaining({ field: "level", source: "Deep" })])
	})
})

describe("B4: a new Bedrock API-key connection", () => {
	const id = "11111111-1111-4111-8111-111111111111"
	const ref = `settings:v1:connection:${id}:awsBedrockApiKey`
	/** What firstModelFromDraft and the Models page save. */
	const saved = async (authentication: string, extra: Seed = {}) => {
		const f = await migrated({})
		f.settings.connections.push({
			id,
			name: "B",
			requestTimeoutMs: null,
			defaults: {},
			kind: "provider",
			providerId: "bedrock",
			baseUrl: "https://wire.test",
			auth: { kind: "none" },
			headers: [],
			options: { awsRegion: "us-east-1", awsAuthentication: authentication, ...extra },
			secretRefs: { awsBedrockApiKey: ref },
		} as never)
		f.settings.models.push({
			id: "row",
			connectionId: id,
			upstreamId: "anthropic.claude-opus-4-5-20251101-v1:0",
			name: "",
			kind: "chat",
			overrides: {},
			providerOptions: {},
		} as never)
		await f.secrets.set(ref, "BK")
		return { ...f, build: () => f.build({ modelId: "row", levelId: "default" }) }
	}
	it("sends the key", async () => {
		const f = await saved("apikey")
		const config = await f.build()
		expect(config.apiKey).toBe("BK")
		const { headers, url } = await wire(config)
		expect(url).toContain("wire.test")
		expect(headers.get("authorization")).toBe("Bearer BK")
	})
	it("leaves a key behind when the connection moved to AWS credentials", async () => {
		const f = await saved("credentials")
		expect((await f.build()).apiKey).toBe("")
	})
	it("a migrated API-key profile still sends its key", async () => {
		const f = await migrated(
			{
				apiConfigProfiles: [
					{
						id: "p",
						name: "p",
						provider: "bedrock",
						modelId: "anthropic.claude-opus-4-5-20251101-v1:0",
						options: { awsRegion: "us-east-1", awsBedrockEndpoint: "https://wire.test", awsAuthentication: "apikey" },
					},
				],
				...assign("p"),
			},
			{ "profile:p:awsBedrockApiKey": "BK" },
		)
		expect((await wire(await f.build())).headers.get("authorization")).toBe("Bearer BK")
	})
})

describe("B5: the list after moving is what was set up", () => {
	const url = "https://ai.acme.example/v1"
	const stores = {
		providers: {
			lastUsedProvider: "openai-compatible",
			providers: {
				"openai-compatible": {
					settings: { provider: "openai-compatible", model: "gpt-6-sol", baseUrl: url, apiKey: "K" },
				},
				anthropic: { settings: { provider: "anthropic", model: "claude-opus-4-5-20251101", apiKey: "OLD" } },
			},
		},
		models: {
			version: 1,
			providers: {
				"openai-compatible": {
					provider: { baseUrl: url },
					models: { "gpt-6-sol": { id: "gpt-6-sol" }, "other-listed": { id: "other-listed" } },
				},
				groq: { models: { "groq-stray": { id: "groq-stray" } } },
			},
		},
	}
	const owner = {
		apiConfigProfiles: [profile("sol", "gpt-6-sol"), profile("mini", "gpt-6-mini")],
		profiles: [{ id: "hi", configurationId: "sol", reasoningEffort: "high" }],
		threadDefaultProfileId: "hi",
		...assign("sol"),
	}
	const ownerKeys = { "profile:sol:openAiApiKey": "K", "profile:mini:openAiApiKey": "K" }

	it("adds nothing for a provider saved configurations cover, and no extra models.json model", async () => {
		const f = await migrated(owner, ownerKeys, stores)
		expect(f.rows()).toEqual(["gpt-6-sol", "gpt-6-mini", "claude-opus-4-5-20251101"])
		expect(f.settings.connections.filter((c) => c.auth.kind === "sdk-account").map((c) => c.name)).toEqual(["anthropic"])
		expect(f.settings.roles.chat).toEqual({ modelId: f.rowOf("gpt-6-sol").id, levelId: "high" })
	})
	it("adds nothing at all once every listed provider is covered", async () => {
		const seed = {
			...owner,
			apiConfigProfiles: [
				...owner.apiConfigProfiles,
				{ id: "a", name: "a", provider: "anthropic", modelId: "claude-sonnet-4-6", options: {} },
			],
		}
		const f = await migrated(seed, { ...ownerKeys, "profile:a:apiKey": "A" }, stores)
		expect(f.rows()).toEqual(["gpt-6-sol", "gpt-6-mini", "claude-sonnet-4-6"])
		expect(f.settings.connections.some((c) => c.auth.kind === "sdk-account")).toBe(false)
	})
	it("still reads a saved row's details from models.json", async () => {
		const f = await migrated(owner, ownerKeys, {
			models: { version: 1, providers: { "openai-compatible": { models: { "gpt-6-sol": { contextWindow: 123_000 } } } } },
		})
		expect(f.values("gpt-6-sol").contextWindow).toBe(123_000)
		expect(f.rows()).not.toContain("other-listed")
	})
	it("imports providers.json when nothing else is set up", async () => {
		const f = await migrated({}, {}, stores)
		expect(f.rows()).toEqual(["gpt-6-sol", "claude-opus-4-5-20251101"])
		expect(f.settings.roles.chat?.modelId).toBe(f.rowOf("gpt-6-sol").id)
	})
	it("a flat selection isn't doubled by the providers.json entry that mirrors it", async () => {
		const flat = {
			actModeApiProvider: "openai",
			planModeApiProvider: "openai",
			actModeOpenAiModelId: "gpt-6-sol",
			planModeOpenAiModelId: "gpt-6-sol",
			openAiBaseUrl: url,
		}
		const f = await migrated(flat, { openAiApiKey: "K" }, { providers: stores.providers })
		expect(f.rows()).toEqual(["claude-opus-4-5-20251101", "gpt-6-sol"])
		expect(f.settings.roles.chat?.modelId).toBe(f.rowOf("gpt-6-sol").id)
	})
	it("a flat selection with no key of its own keeps running on the account entry", async () => {
		const flat = {
			actModeApiProvider: "openai",
			planModeApiProvider: "openai",
			actModeOpenAiModelId: "gpt-6-sol",
			planModeOpenAiModelId: "gpt-6-sol",
			openAiBaseUrl: url,
		}
		const f = await migrated(flat, {}, { providers: stores.providers })
		expect(f.rows()).toEqual(["gpt-6-sol", "claude-opus-4-5-20251101"])
		const chat = f.settings.models.find((m) => m.id === f.settings.roles.chat?.modelId)!
		expect(f.settings.connections.find((c) => c.id === chat.connectionId)?.auth.kind).toBe("sdk-account")
	})
})

describe("subagent settings that legacy wasn't using", () => {
	const two = {
		apiConfigProfiles: [profile("p", "m"), profile("q", "exp")],
		profiles: [{ id: "qh", configurationId: "q", reasoningEffort: "xhigh" }],
		...assign("p"),
		subagentDefaultModelProfileId: "qh",
		subagentAllowedModelProfileIds: ["qh"],
		subagentReasoningEffort: "low",
	}
	const keys = { "profile:p:openAiApiKey": "K", "profile:q:openAiApiKey": "K" }
	it.each([false, undefined])("imports nothing while the feature is %s", async (enabled) => {
		const f = await migrated({ ...two, subagentProfilesEnabled: enabled }, keys)
		expect(f.settings.subagents.allowed).toEqual([])
		expect(f.settings.roles.subagents).toEqual({ kind: "thread", level: "inherit" })
	})
	it("imports them when it's on", async () => {
		const f = await migrated({ ...two, subagentProfilesEnabled: true }, keys)
		expect(f.settings.subagents.allowed).toEqual([{ kind: "model", modelId: f.rowOf("exp").id, levels: ["xhigh"] }])
		expect(f.settings.roles.subagents).toMatchObject({ kind: "model" })
	})
	it("drops a stale allowed entry with an issue, and makes no row for it", async () => {
		const f = await migrated(
			{
				...two,
				subagentProfilesEnabled: true,
				profiles: [...two.profiles, { id: "orphan", configurationId: "gone" }],
				subagentAllowedModelProfileIds: ["qh", "gone-entirely", "orphan", "parent"],
			},
			keys,
		)
		expect(f.settings.subagents.allowed).toEqual([
			{ kind: "model", modelId: f.rowOf("exp").id, levels: ["xhigh"] },
			{ kind: "thread", levels: ["inherit"] },
		])
		expect(f.settings.models.map((m) => m.name)).not.toContain("Unavailable saved model")
		expect(f.settings.connections.map((c) => c.name)).not.toContain("Unavailable legacy connection")
		expect(f.issues).toEqual([
			expect.objectContaining({ kind: "dropped", field: "subagentAllowedModelProfileIds", source: "Subagents" }),
		])
	})
})

describe("a reference to something that's gone", () => {
	const noRow = (settings: ModelSettings) => {
		expect(settings.models.map((m) => m.name)).not.toContain("Unavailable saved model")
		expect(settings.connections.map((c) => c.name)).not.toContain("Unavailable legacy connection")
	}
	const one = { apiConfigProfiles: [profile("p", "m")], ...assign("p") }
	const key = { "profile:p:openAiApiKey": "K" }

	it("Titles and Generate fall back to Chat, with one issue", async () => {
		const f = await migrated(
			{
				...one,
				threadTitlesEnabled: true,
				threadTitlesModelProfileId: "gone",
				walkthroughGenerateModelProfileId: "gone-too",
			},
			key,
		)
		noRow(f.settings)
		expect(f.rows()).toEqual(["m"])
		expect(f.settings.roles.background.pick).toEqual(f.settings.roles.chat)
		expect(f.settings.roles.background.overrides.generate).toBeUndefined()
		expect(f.issues).toEqual([expect.objectContaining({ kind: "dropped", source: "Background text" })])
	})
	it("the subagent default runs on the thread's model, as legacy does", async () => {
		const f = await migrated({ ...one, subagentProfilesEnabled: true, subagentDefaultModelProfileId: "gone" }, key)
		noRow(f.settings)
		expect(f.settings.roles.subagents).toEqual({ kind: "thread", level: "inherit" })
		expect(f.issues).toEqual([expect.objectContaining({ kind: "dropped", source: "Subagents" })])
	})
	it("Chat with nothing to run stays unpicked, which says why and links to the fix", async () => {
		const f = await migrated({ actProfileId: "gone", askProfileId: "gone" })
		noRow(f.settings)
		expect(f.settings.models).toEqual([])
		expect(f.settings.roles.chat).toBeNull()
	})
	it("a flat row's issue is named for its role, not an internal id", async () => {
		const f = await migrated(
			{
				actModeApiProvider: "anthropic",
				planModeApiProvider: "anthropic",
				actModeApiModelId: "claude-sonnet-4-5-20250929",
				planModeApiModelId: "claude-sonnet-4-5-20250929",
				actModeReasoningEffort: "xhigh",
			},
			{ apiKey: "K" },
		)
		expect(f.issues.find((i) => i.field === "level")?.source).toBe("Chat")
	})
})

describe("connection names", () => {
	const key = (...ids: string[]) => Object.fromEntries(ids.map((id) => [`profile:${id}:openAiApiKey`, "K"]))
	it("a grouped connection is named for its host", async () => {
		const f = await migrated(
			{ apiConfigProfiles: [profile("GPT-5.4", "a"), profile("Sol", "b")], ...assign("Sol") },
			key("GPT-5.4", "Sol"),
		)
		expect(f.settings.connections.map((c) => c.name)).toEqual(["ai.acme.example"])
	})
	it("keeps a port that isn't the default, and never a URL's credentials", async () => {
		const options = { openAiBaseUrl: "https://user:pass@ai.acme.example:8443/v1" }
		const f = await migrated(
			{ apiConfigProfiles: [profile("a", "a", options), profile("b", "b", options)], ...assign("a") },
			key("a", "b"),
		)
		expect(f.settings.connections.map((c) => c.name)).toEqual(["ai.acme.example:8443"])
	})
	it.each([
		"http://localhost:11434/v1",
		"http://127.0.0.1:1234/v1",
		"http://[::1]:8000/v1",
	])("%s is a local server", async (openAiBaseUrl) => {
		const f = await migrated(
			{ apiConfigProfiles: [profile("a", "a", { openAiBaseUrl }), profile("b", "b", { openAiBaseUrl })], ...assign("a") },
			key("a", "b"),
		)
		expect(f.settings.connections.map((c) => c.name)).toEqual(["Local server"])
	})
	it("a single profile keeps its name", async () => {
		const f = await migrated({ apiConfigProfiles: [profile("Mine", "m")], ...assign("Mine") }, key("Mine"))
		expect(f.settings.connections.map((c) => c.name)).toEqual(["Mine"])
	})
	it("two groups on one host stay told apart", async () => {
		const f = await migrated(
			{ apiConfigProfiles: ["a", "b", "c", "d"].map((id) => profile(id, id)), ...assign("a") },
			{
				"profile:a:openAiApiKey": "K1",
				"profile:b:openAiApiKey": "K1",
				"profile:c:openAiApiKey": "K2",
				"profile:d:openAiApiKey": "K2",
			},
		)
		expect(f.settings.connections.map((c) => c.name)).toEqual(["ai.acme.example", "ai.acme.example 2"])
	})
	it("a connection with no URL is named for its provider", async () => {
		const anthropic = (id: string, modelId: string) => ({ id, name: id, provider: "anthropic", modelId, options: {} })
		const f = await migrated(
			{ apiConfigProfiles: [anthropic("a", "claude-sonnet-4-6"), anthropic("b", "claude-opus-4-7")], ...assign("a") },
			{ "profile:a:apiKey": "K", "profile:b:apiKey": "K" },
		)
		expect(f.settings.connections.map((c) => c.name)).toEqual(["Anthropic"])
	})
})

describe("keys for merged connections", () => {
	it("stores one copy, on the connection that was kept", async () => {
		const f = await migrated(
			{ apiConfigProfiles: [profile("a", "a"), profile("b", "b")], ...assign("a") },
			{ "profile:a:openAiApiKey": "K", "profile:b:openAiApiKey": "K" },
		)
		const [connection] = f.settings.connections
		if (connection.auth.kind !== "keychain") throw new Error("expected keychain")
		expect(await f.secrets.list()).toEqual([connection.auth.secretRef])
		expect(await f.secrets.get(connection.auth.secretRef)).toBe("K")
	})
})

describe("Detect during a running turn", () => {
	it("isn't taken for the organization changing the model", async () => {
		const f = await migrated({ apiConfigProfiles: [profile("p", "m")], ...assign("p") }, { "profile:p:openAiApiKey": "K" })
		const config = await f.build()
		await expect(config[requestPolicyGuard]?.()).resolves.toBeUndefined()
		rememberDetectedModelMetadata(f.store, f.settings.roles.chat!.modelId, f.settings.revision, { contextWindow: 200_000 })
		await expect(config[requestPolicyGuard]?.()).resolves.toBeUndefined()
	})
	it("a real organization change still stops it", async () => {
		const f = await migrated({ apiConfigProfiles: [profile("p", "m")], ...assign("p") }, { "profile:p:openAiApiKey": "K" })
		const config = await f.build()
		f.remote.remoteProviderSettings = { OpenAiCompatible: { models: [{ id: "m", contextWindow: 1234 }] } }
		await expect(config[requestPolicyGuard]?.()).rejects.toThrow(/Your organization changed/)
	})
})
