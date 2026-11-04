import { createGateway } from "@cline/llms"
import {
	createCompatibleConnection,
	createDefaultModelSettings,
	type ModelSettings,
	ModelValuesSchema,
} from "@shared/model-settings"
import { describe, expect, it, vi } from "vitest"
import { DependencyError, mutateSettings, savedThreadUsage } from "@/core/controller/models/modelSettingsRpc"
import { InMemoryConnectionSecretStore } from "./connection-secret-store"
import { resolveConfiguredPick, resolveThreadPick } from "@/sdk/model-settings-resolver"
import {
	assertConfiguredModelRequestAllowed,
	catalogModelValues,
	catalogReasoningLevels,
	managedModelValues,
	readModelSettingsState,
	rememberDetectedModelMetadata,
} from "./host-settings"

vi.mock("@/shared/services/Logger", () => ({ Logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

function fixture() {
	let settings = createDefaultModelSettings()
	const connectionSecrets = new InMemoryConnectionSecretStore()
	const postStateToWebview = vi.fn()
	const history: Array<{ id: string; modelSelectionV1: unknown }> = []
	const managed: Record<string, unknown> = {}
	const state = {
		connectionSecrets,
		getGlobalStateKey: (key: string) => (key === "modelSettings" ? settings : []),
		getRemoteConfigSettings: () => managed,
		getModelSettingsMigrationStatus: () => ({ status: "disabled", retryable: false }),
		mutateModelSettings: async (revision: number, mutate: (value: ModelSettings) => Promise<void>) => {
			if (revision !== settings.revision) throw new Error("revision")
			const next = structuredClone(settings)
			await mutate(next)
			next.revision++
			settings = next
		},
	}
	const controller = {
		stateManager: state,
		postStateToWebview,
		getModelSelectionDependencies: async () => history,
	}
	const call = (operation: Parameters<typeof mutateSettings>[1], input: unknown) =>
		mutateSettings(controller as never, operation, JSON.stringify(input), true)
	return { history, managed, state, controller, call, get: () => settings, connectionSecrets, postStateToWebview }
}

describe("new settings host mutations", () => {
	it("reads defaults without writing and returns no secret values", async () => {
		const f = fixture()
		expect((await readModelSettingsState(f.state as never)).settings.revision).toBe(0)
		expect(f.get().connections).toEqual([])
	})
	it("saves write-only secrets and rejects placeholders before changing a credential", async () => {
		const f = fixture()
		const connection = createCompatibleConnection("c")
		const result = await f.call("saveConnection", {
			expectedRevision: 0,
			connection,
			secrets: [{ field: "apiKey", operation: "set", value: "real-test-secret" }],
		})
		expect(JSON.stringify(result)).not.toContain("real-test-secret")
		expect(await f.connectionSecrets.get(connection.auth.kind === "keychain" ? connection.auth.secretRef : "")).toBe(
			"real-test-secret",
		)
		await expect(
			f.call("saveConnection", {
				expectedRevision: 1,
				connection,
				secrets: [{ field: "apiKey", operation: "set", value: "••••••" }],
			}),
		).rejects.toThrow()
		expect(f.get().revision).toBe(1)
		expect(f.postStateToWebview).toHaveBeenCalledWith(true)
	})
	it("rejects foreign secret refs and fields before writing", async () => {
		const f = fixture()
		const connection = createCompatibleConnection("c")
		await expect(
			f.call("saveConnection", {
				expectedRevision: 0,
				connection: { ...connection, auth: { kind: "keychain", secretRef: "settings:v1:connection:other:apiKey" } },
				secrets: [],
			}),
		).rejects.toThrow(/secret reference/i)
		await expect(
			f.call("saveConnection", {
				expectedRevision: 0,
				connection,
				secrets: [{ field: "other", operation: "set", value: "secret" }],
			}),
		).rejects.toThrow("secret field")
		expect(f.get().revision).toBe(0)
	})
	it("preserves keep, deletes only on explicit delete, and checks revisions", async () => {
		const f = fixture()
		const connection = createCompatibleConnection("c")
		await f.connectionSecrets.set("settings:v1:connection:c:apiKey", "test-key")
		await f.call("saveConnection", { expectedRevision: 0, connection, secrets: [{ field: "apiKey", operation: "keep" }] })
		expect(await f.connectionSecrets.get("settings:v1:connection:c:apiKey")).toBe("test-key")
		await expect(f.call("saveConnection", { expectedRevision: 0, connection })).rejects.toThrow("revision")
		await f.call("saveConnection", { expectedRevision: 1, connection, secrets: [{ field: "apiKey", operation: "delete" }] })
		expect(await f.connectionSecrets.get("settings:v1:connection:c:apiKey")).toBeUndefined()
	})
	it("adds rows atomically without assigning roles; duplicates remain drafts", async () => {
		const f = fixture()
		await f.call("saveConnection", { expectedRevision: 0, connection: createCompatibleConnection("c") })
		const row = {
			id: "m",
			connectionId: "c",
			upstreamId: "upstream",
			name: "Name",
			kind: "chat",
			overrides: {},
			providerOptions: {},
		}
		await expect(
			f.call("saveConfiguredModels", {
				expectedRevision: 1,
				models: [row, { ...row, id: "bad", connectionId: "missing" }],
			}),
		).rejects.toThrow()
		expect(f.get().models).toEqual([])
		await f.call("saveConfiguredModels", { expectedRevision: 1, models: [row] })
		expect(f.get().roles.chat).toBeNull()
		const copy = (await f.call("duplicateConfiguredModel", { modelId: "m" })) as { draft: typeof row }
		expect(copy.draft).toMatchObject({ upstreamId: "", name: "", connectionId: "c" })
		expect(copy.draft.id).not.toBe("m")
		expect(f.get().models).toHaveLength(1)
	})
	it("routes Make default for Ask and reports dependencies instead of silently replacing picks", async () => {
		const f = fixture()
		await f.call("saveConnection", { expectedRevision: 0, connection: createCompatibleConnection("c") })
		await f.call("saveConfiguredModels", {
			expectedRevision: 1,
			models: [
				{ id: "m", connectionId: "c", upstreamId: "model", name: "", kind: "chat", overrides: {}, providerOptions: {} },
			],
		})
		const pick = { modelId: "m", levelId: "default" }
		await f.call("makeModelDefault", { expectedRevision: 2, mode: "plan", pick })
		expect(f.get().roles.chat).toEqual(pick)
		await expect(f.call("deleteConfiguredModel", { expectedRevision: 3, modelId: "m" })).rejects.toBeInstanceOf(
			DependencyError,
		)
		expect(f.get().models).toHaveLength(1)
		await expect(f.call("deleteConnection", { expectedRevision: 3, connectionId: "c" })).rejects.toBeInstanceOf(
			DependencyError,
		)
		const roles = { ...f.get().roles, chat: null, ask: { enabled: true, pick: null } }
		await f.call("setModelRoles", { expectedRevision: 3, roles })
		await f.call("makeModelDefault", { expectedRevision: 4, mode: "plan", pick })
		expect(f.get().roles.ask.pick).toEqual(pick)
		expect(f.get().roles.chat).toBeNull()
	})
})

describe("Phase 4 host boundaries", () => {
	it("rejects writes with rollout disabled before accessing the store", async () => {
		await expect(mutateSettings({} as never, "deleteConnection", "{}")).rejects.toThrow("disabled")
	})
	it("patches only present fields and preserves null, false and zero", async () => {
		const f = fixture()
		await f.call("saveConnection", {
			expectedRevision: 0,
			connection: { ...createCompatibleConnection("c"), defaults: { contextWindow: 1000, free: true, temperature: 1 } },
		})
		await f.call("saveConnection", {
			expectedRevision: 1,
			connection: { id: "c", defaults: { temperature: 0, free: false }, baseUrl: "https://example.invalid" },
		})
		expect(f.get().connections[0].defaults).toEqual({ contextWindow: 1000, temperature: 0, free: false })
		await f.call("saveConnection", {
			expectedRevision: 2,
			connection: { id: "c", baseUrl: null, defaults: { contextWindow: null } },
		})
		expect(f.get().connections[0]).toMatchObject({
			baseUrl: null,
			defaults: { contextWindow: null, temperature: 0, free: false },
		})
	})
	it("saved threads warn but don't block; roles and policy still do; a reopened thread refuses with the route", async () => {
		const f = fixture()
		await f.call("saveConnection", { expectedRevision: 0, connection: createCompatibleConnection("c") })
		await f.call("saveConfiguredModels", {
			expectedRevision: 1,
			models: [
				{ id: "m", connectionId: "c", upstreamId: "test", name: "", kind: "chat", overrides: {}, providerOptions: {} },
			],
		})
		const pick = { modelId: "m", levelId: "default" }
		const selection = { version: 1 as const, ask: pick, act: pick }
		f.history.push(
			{ id: "t1", modelSelectionV1: selection },
			{ id: "t2:live", modelSelectionV1: selection },
			{ id: "t2", modelSelectionV1: selection },
			{ id: "t3:next-message", modelSelectionV1: { act: pick } },
			{ id: "home:draft", modelSelectionV1: selection },
			{ id: "other", modelSelectionV1: { version: 1, ask: null, act: { modelId: "n", levelId: "default" } } },
		)
		const usage = () => savedThreadUsage(f.controller as never, JSON.stringify({ modelIds: ["m"] }), true)
		expect(await usage()).toEqual({ savedThreads: 3 })
		await expect(savedThreadUsage(f.controller as never, JSON.stringify({ modelIds: ["m"] }), false)).rejects.toThrow(
			/rollout/,
		)
		f.get().roles.chat = pick
		f.get().subagents.allowed = [{ kind: "model", modelId: "m", levels: ["default"] }]
		try {
			await f.call("deleteConfiguredModel", { expectedRevision: 2, modelId: "m" })
			throw new Error("expected dependency refusal")
		} catch (error) {
			expect((error as DependencyError).dependencies).toEqual(["roles.chat", "subagents.allowed.0"])
		}
		f.get().roles.chat = null
		f.get().subagents.allowed = []
		await f.call("deleteConfiguredModel", { expectedRevision: 2, modelId: "m" })
		expect(() => resolveConfiguredPick(f.get(), resolveThreadPick(selection, "act"))).toThrow(/Settings > Models/)
	})
	it.each([
		"openAiBaseUrl",
		"openAiHeaders",
		"azureApiVersion",
		"azureIdentity",
	])("enforces %s on connection patches", async (key) => {
		const f = fixture()
		await f.call("saveConnection", { expectedRevision: 0, connection: createCompatibleConnection("c") })
		f.managed[key] = key === "openAiHeaders" ? {} : key === "azureIdentity" ? false : "managed"
		const patches: Record<string, unknown> = {
			openAiBaseUrl: { baseUrl: "https://bad.invalid" },
			openAiHeaders: { headers: [{ id: "h", name: "X-Test", storage: "plain", value: "bad" }] },
			azureApiVersion: { azureApiVersion: "bad" },
			azureIdentity: { auth: { kind: "azure-identity" } },
		}
		await expect(
			f.call("saveConnection", { expectedRevision: 1, connection: { id: "c", ...(patches[key] as object) } }),
		).rejects.toThrow(/managed/)
		expect(f.get().revision).toBe(1)
	})
})

describe("managed RPC mutation matrix", () => {
	it.each([
		"saveConnection",
		"saveConfiguredModels",
		"duplicateConfiguredModel",
		"deleteConfiguredModel",
		"deleteConnection",
		"setModelRoles",
		"setSubagentPolicy",
		"makeModelDefault",
	] as const)("%s cannot bypass managed provider restrictions", async (operation) => {
		const f = fixture()
		const connection = createCompatibleConnection("c")
		const row = { id: "m", connectionId: "c", upstreamId: "test", name: "", kind: "chat", overrides: {}, providerOptions: {} }
		await f.call("saveConnection", { expectedRevision: 0, connection })
		await f.call("saveConfiguredModels", { expectedRevision: 1, models: [row] })
		f.managed.remoteConfiguredProviders = ["anthropic"]
		const cases = {
			saveConnection: { expectedRevision: 2, connection: { id: "c", name: "Changed" } },
			saveConfiguredModels: { expectedRevision: 2, models: [{ ...row, upstreamId: "other" }] },
			duplicateConfiguredModel: { modelId: "m" },
			deleteConfiguredModel: { expectedRevision: 2, modelId: "m" },
			deleteConnection: { expectedRevision: 2, connectionId: "c" },
			setModelRoles: { expectedRevision: 2, roles: { ...f.get().roles, chat: { modelId: "m", levelId: "default" } } },
			setSubagentPolicy: { expectedRevision: 2, subagents: { ...f.get().subagents, maxConcurrent: 0 } },
			makeModelDefault: { expectedRevision: 2, mode: "act", pick: { modelId: "m", levelId: "default" } },
		}
		await expect(f.call(operation, cases[operation])).rejects.toThrow()
		expect(f.get().revision).toBe(2)
	})
})

describe("clearing values and the request timeout", () => {
	const seeded = async () => {
		const f = fixture()
		const connection = {
			...createCompatibleConnection("c"),
			kind: "provider" as const,
			providerId: "bedrock",
			auth: { kind: "none" as const },
			options: { awsRegion: "us-east-1", awsProfile: "work" },
			secretRefs: { awsSessionToken: "settings:v1:connection:c:awsSessionToken" },
			defaults: { contextWindow: 1000, temperature: 0, free: false },
		}
		const { apiFormat: _apiFormat, azureApiVersion: _azure, ...provider } = connection
		await f.call("saveConnection", {
			expectedRevision: 0,
			connection: provider,
			secrets: [{ field: "awsSessionToken", operation: "set", value: "session-secret" }],
		})
		return f
	}

	it("saves and clears the request timeout without touching roles", async () => {
		const f = fixture()
		const roles = f.get().roles
		await f.call("setModelRoles", { expectedRevision: 0, roles, requestTimeoutMs: 45000 })
		expect(f.get().requestTimeoutMs).toBe(45000)
		await f.call("setModelRoles", { expectedRevision: 1, roles })
		expect(f.get().requestTimeoutMs).toBe(45000)
		await f.call("setModelRoles", { expectedRevision: 2, roles, requestTimeoutMs: null })
		expect(f.get().requestTimeoutMs).toBeNull()
		await expect(f.call("setModelRoles", { expectedRevision: 3, roles, requestTimeoutMs: 0 })).rejects.toThrow()
	})

	it("removes named keys, keeps null, false and zero, and refuses both at once", async () => {
		const f = await seeded()
		await f.call("saveConnection", {
			expectedRevision: 1,
			connection: { id: "c", remove: { defaults: ["contextWindow"], options: ["awsProfile"] } },
		})
		const saved = f.get().connections[0]
		expect(saved.defaults).toEqual({ temperature: 0, free: false })
		expect(saved.kind === "provider" && saved.options).toEqual({ awsRegion: "us-east-1" })
		await f.call("saveConnection", { expectedRevision: 2, connection: { id: "c", defaults: { maxOutputTokens: null } } })
		expect(f.get().connections[0].defaults).toEqual({ temperature: 0, free: false, maxOutputTokens: null })
		await expect(
			f.call("saveConnection", {
				expectedRevision: 3,
				connection: { id: "c", defaults: { temperature: 1 }, remove: { defaults: ["temperature"] } },
			}),
		).rejects.toThrow(/set and remove/)
		expect(f.get().connections[0].defaults.temperature).toBe(0)
	})

	it("deletes a provider secret and its reference together, so the connection isn't left broken", async () => {
		const f = await seeded()
		const ref = "settings:v1:connection:c:awsSessionToken"
		await f.call("saveConnection", {
			expectedRevision: 1,
			connection: { id: "c", remove: { secretRefs: ["awsSessionToken"] } },
			secrets: [{ field: "awsSessionToken", operation: "delete" }],
		})
		const saved = f.get().connections[0]
		expect(saved.kind === "provider" && saved.secretRefs).toEqual({})
		expect(await f.connectionSecrets.get(ref)).toBeUndefined()
		// Setting needs a live reference; a delete with none left is refused too.
		await expect(
			f.call("saveConnection", {
				expectedRevision: 2,
				connection: { id: "c" },
				secrets: [{ field: "awsSessionToken", operation: "delete" }],
			}),
		).rejects.toThrow(/secret field/)
	})
})

describe("catalog levels and fix targets", () => {
	const levelIds = (options: Parameters<typeof catalogReasoningLevels>[0]) => catalogReasoningLevels(options)?.map((l) => l.id)

	it("derives levels from reasoning metadata", () => {
		const capabilities = ["reasoning"]
		expect(levelIds({ capabilities: [] })).toBeUndefined()
		expect(
			levelIds({ capabilities, reasoningOptions: [{ type: "effort", values: ["none", "high", "low", "default", null] }] }),
		).toEqual(["default", "low", "high"])
		expect(levelIds({ capabilities })).toEqual(["default", "low", "medium", "high"])
		expect(levelIds({ capabilities, reasoningOptions: [{ type: "toggle" }] })).toBeUndefined()
		expect(
			catalogReasoningLevels({ capabilities, reasoningOptions: [{ type: "budget_tokens", min: 2000, max: 4000 }] })?.map(
				(level) => level.request,
			),
		).toEqual([
			{ kind: "default" },
			{ kind: "thinking-budget", tokens: 2000 },
			{ kind: "thinking-budget", tokens: 2000 },
			{ kind: "thinking-budget", tokens: 4000 },
		])
	})

	it("every catalog model projects valid values, and a reasoning one offers real levels", () => {
		const gateway = createGateway()
		let withLevels = 0
		for (const provider of gateway.listProviders()) {
			const connection = {
				...createCompatibleConnection("c"),
				kind: "provider" as const,
				providerId: provider.id,
				options: {},
				secretRefs: {},
			}
			const { apiFormat: _apiFormat, azureApiVersion: _azure, ...native } = connection
			for (const model of gateway.listModels(provider.id)) {
				const row = {
					id: "m",
					connectionId: "c",
					upstreamId: model.id,
					name: "",
					kind: "chat" as const,
					overrides: {},
					providerOptions: {},
				}
				const levels = catalogModelValues(row, native).levels
				if (!levels) continue
				withLevels++
				expect(ModelValuesSchema.partial().safeParse({ levels }).success, `${provider.id}/${model.id}`).toBe(true)
			}
		}
		expect(withLevels).toBeGreaterThan(0)
	})

	it("a saved catalog level is usable, and one the catalog doesn't offer points at the model's levels", async () => {
		const f = fixture()
		const model = createGateway()
			.listModels("anthropic")
			.find((m) => catalogReasoningLevels(m)?.some((level) => level.id === "high"))!
		const { apiFormat: _apiFormat, azureApiVersion: _azure, ...base } = createCompatibleConnection("c")
		await f.call("saveConnection", {
			expectedRevision: 0,
			connection: {
				...base,
				kind: "provider",
				providerId: "anthropic",
				options: {},
				secretRefs: {},
				auth: { kind: "none" },
			},
		})
		await f.call("saveConfiguredModels", {
			expectedRevision: 1,
			models: [
				{ id: "m", connectionId: "c", upstreamId: model.id, name: "", kind: "chat", overrides: {}, providerOptions: {} },
			],
		})
		const roles = f.get().roles
		await f.call("setModelRoles", {
			expectedRevision: 2,
			roles: {
				...roles,
				chat: { modelId: "m", levelId: "high" },
				background: { ...roles.background, pick: { modelId: "m", levelId: "ultra" } },
			},
		})
		const state = await readModelSettingsState(f.state as never)
		expect(state.effective.m.levels.source).toBe("metadata")
		expect(state.availability["role.chat"].available).toBe(true)
		expect(state.availability["role.background"]).toMatchObject({
			available: false,
			target: { page: "models", modelId: "m", field: "levels" },
		})
		expect(state.availability["background.titles"].target).toEqual({ page: "models", modelId: "m", field: "levels" })
	})

	it("an empty role points at the role; a model with no key points at its connection", async () => {
		const f = fixture()
		const empty = await readModelSettingsState(f.state as never)
		expect(empty.availability["role.chat"].target).toEqual({ page: "models", role: "chat" })
		expect(empty.availability["background.commitMessages"].target).toEqual({ page: "models", role: "background" })
		await f.call("saveConnection", { expectedRevision: 0, connection: createCompatibleConnection("c") })
		await f.call("saveConfiguredModels", {
			expectedRevision: 1,
			models: [
				{ id: "m", connectionId: "c", upstreamId: "test", name: "", kind: "chat", overrides: {}, providerOptions: {} },
			],
		})
		const state = await readModelSettingsState(f.state as never)
		expect(state.availability.m.target).toEqual({ page: "models", connectionId: "c" })
	})
})

describe("managed and metadata request projections", () => {
	it("projects genuine catalog facts without persisting user overrides", () => {
		const model = createGateway()
			.listModels("anthropic")
			.find((m) => m.contextWindow !== undefined)!
		expect(model).toBeDefined()
		const connection = {
			...createCompatibleConnection("c"),
			kind: "provider" as const,
			providerId: "anthropic",
			options: {},
			secretRefs: {},
		}
		const row = {
			id: "m",
			connectionId: "c",
			upstreamId: model.id,
			name: "",
			kind: "chat" as const,
			overrides: {},
			providerOptions: {},
		}
		expect(catalogModelValues(row, connection).contextWindow).toBe(model.contextWindow)
		expect(row.overrides).toEqual({})
	})
	it("projects managed cache policy and refuses changed organization URL at request time", async () => {
		const f = fixture()
		const connection = createCompatibleConnection("c")
		connection.baseUrl = "https://old.invalid"
		await f.call("saveConnection", { expectedRevision: 0, connection })
		await f.call("saveConfiguredModels", {
			expectedRevision: 1,
			models: [
				{ id: "m", connectionId: "c", upstreamId: "test", name: "", kind: "chat", overrides: {}, providerOptions: {} },
			],
		})
		f.managed.openAiBaseUrl = "https://managed.invalid"
		await expect(
			assertConfiguredModelRequestAllowed(f.state as never, f.get(), { modelId: "m", levelId: "default" }),
		).rejects.toThrow(/managed/)
		f.managed.awsBedrockUsePromptCache = false
		expect(
			managedModelValues(f.state as never, f.get().models[0], {
				...connection,
				kind: "provider",
				providerId: "bedrock",
				options: {},
				secretRefs: {},
			}),
		).toEqual({ promptCache: "no" })
	})
})

it("publishes detected metadata only for its producing revision", async () => {
	const f = fixture()
	await f.call("saveConnection", { expectedRevision: 0, connection: createCompatibleConnection("c") })
	await f.call("saveConfiguredModels", {
		expectedRevision: 1,
		models: [
			{ id: "m", connectionId: "c", upstreamId: "unknown-id", name: "", kind: "chat", overrides: {}, providerOptions: {} },
		],
	})
	rememberDetectedModelMetadata(f.state as never, "m", 2, { contextWindow: 64000 })
	expect((await readModelSettingsState(f.state as never)).effective.m.contextWindow).toEqual({
		value: 64000,
		source: "metadata",
	})
	await f.call("saveConnection", { expectedRevision: 2, connection: { id: "c", name: "new revision" } })
	expect((await readModelSettingsState(f.state as never)).effective.m.contextWindow).toEqual({ value: null, source: "builtin" })
})

it("retains schema-managed provider model tables and applies only declared fields", async () => {
	const { transformRemoteConfigToStateShape } = await import("@/core/storage/remote-config/utils")
	const { RemoteConfigSchema } = await import("@shared/remote-config/schema")
	const remote = RemoteConfigSchema.parse({
		version: "v1",
		providerSettings: {
			OpenAiCompatible: {
				models: [{ id: "test", contextWindow: 12345, temperature: 0, supportsImages: false, invented: true }],
			},
		},
	})
	const transformed = transformRemoteConfigToStateShape(remote)
	expect(transformed.remoteProviderSettings?.OpenAiCompatible?.models?.[0]).toEqual({
		id: "test",
		contextWindow: 12345,
		temperature: 0,
		supportsImages: false,
	})
})

it.each([
	["OpenAiCompatible", "openai"],
	["AwsBedrock", "bedrock"],
	["Cline", "cline"],
	["Vertex", "vertex"],
	["LiteLLM", "litellm"],
	["Anthropic", "anthropic"],
])("enforces the existing %s remote model allowlist", async (table, providerId) => {
	const f = fixture()
	const settings = createDefaultModelSettings()
	settings.connections = [
		providerId === "openai"
			? createCompatibleConnection("c")
			: ({
					id: "c",
					name: "Native",
					kind: "provider",
					providerId,
					baseUrl: null,
					auth: { kind: "none" },
					headers: [],
					defaults: {},
					requestTimeoutMs: null,
					options: {},
					secretRefs: {},
				} as never),
	]
	settings.models = [
		{ id: "m", connectionId: "c", upstreamId: "test", name: "", kind: "chat", overrides: {}, providerOptions: {} },
	]
	f.managed.remoteProviderSettings = { [table]: { models: [{ id: "other" }] } }
	await expect(
		assertConfiguredModelRequestAllowed(f.state as never, settings, { modelId: "m", levelId: "default" }),
	).rejects.toThrow(/organization/)
	f.managed.remoteProviderSettings = { [table]: { models: [{ id: "test" }] } }
	await expect(
		assertConfiguredModelRequestAllowed(f.state as never, settings, { modelId: "m", levelId: "default" }),
	).resolves.toBeUndefined()
})
