import { createGateway } from "@cline/llms"
import {
	BASE_URL_NEEDED,
	createCompatibleConnection,
	createDefaultModelSettings,
	MODEL_ID_NEEDED,
	type ModelRow,
	type ModelSettings,
	ModelValuesSchema,
} from "@shared/model-settings"
import { describe, expect, it, vi } from "vitest"
import { mutateSettings, savedThreadUsage } from "@/core/controller/models/modelSettingsRpc"
import { resolveConfiguredPick, resolveThreadPick } from "@/sdk/model-settings-resolver"
import { InMemoryConnectionSecretStore } from "./connection-secret-store"
import {
	assertConfiguredModelRequestAllowed,
	catalogModelValues,
	catalogReasoningLevels,
	managedModelValues,
	readModelSettingsState,
	rememberDetectedModelMetadata,
	resolveEffectiveConfiguredPick,
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
	it("removing a connection clears every key under it, including ones it no longer names", async () => {
		const f = fixture()
		const connection = createCompatibleConnection("c")
		await f.call("saveConnection", {
			expectedRevision: 0,
			connection,
			secrets: [{ field: "apiKey", operation: "set", value: "named" }],
		})
		await f.connectionSecrets.set("settings:v1:connection:c:header-0", "left behind")
		await f.connectionSecrets.set("settings:v1:connection:other:apiKey", "someone else's")
		await f.call("deleteConnection", { expectedRevision: 1, connectionId: "c" })
		expect(await f.connectionSecrets.list()).toEqual(["settings:v1:connection:other:apiKey"])
	})
	it("unlocking a moved header keeps its value as text and clears the keychain", async () => {
		const f = fixture()
		const secretRef = "settings:v1:connection:c:header-0"
		const connection = {
			...createCompatibleConnection("c"),
			auth: { kind: "none" as const },
			headers: [
				{ id: "header-0", name: "X-Api-Key", storage: "secret" as const, secretRef },
				{ id: "header-1", name: "X-Other", storage: "plain" as const, value: "stays" },
			],
		}
		await f.call("saveConnection", {
			expectedRevision: 0,
			connection,
			secrets: [{ field: "header-0", operation: "set", value: "abc" }],
		})
		await f.call("saveConnection", {
			expectedRevision: 1,
			connection: { id: "c" },
			secrets: [{ field: "header-0", operation: "unlock" }],
		})
		expect(f.get().connections[0].headers).toEqual([
			{ id: "header-0", name: "X-Api-Key", storage: "plain", value: "abc" },
			{ id: "header-1", name: "X-Other", storage: "plain", value: "stays" },
		])
		expect(await f.connectionSecrets.get(secretRef)).toBeUndefined()
	})
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
	it("routes Make default for Ask", async () => {
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
		const roles = { ...f.get().roles, chat: null, ask: { enabled: true, pick: null } }
		await f.call("setModelRoles", { expectedRevision: 3, roles })
		await f.call("makeModelDefault", { expectedRevision: 4, mode: "plan", pick })
		expect(f.get().roles.ask.pick).toEqual(pick)
	})
	describe("removing is one step", () => {
		const everywhere = async () => {
			const f = fixture()
			await f.call("saveConnection", { expectedRevision: 0, connection: createCompatibleConnection("c") })
			await f.call("saveConfiguredModels", {
				expectedRevision: 1,
				models: ["m", "n"].map((id) => ({
					id,
					connectionId: "c",
					upstreamId: id,
					name: "",
					kind: "chat",
					overrides: {},
					providerOptions: {},
				})),
			})
			const pick = { modelId: "m", levelId: "default" }
			f.get().roles = {
				chat: pick,
				ask: { enabled: true, pick },
				subagents: { kind: "model", pick },
				background: { pick, titlesEnabled: true, overrides: { titles: pick, generate: pick } },
			}
			f.get().subagents.allowed = [
				{ kind: "model", modelId: "m", levels: ["default"] },
				{ kind: "thread", levels: ["default"] },
			]
			return f
		}
		const clearedEverywhere = (f: Awaited<ReturnType<typeof everywhere>>) => {
			expect(f.get().roles).toEqual({
				chat: null,
				ask: { enabled: false, pick: null },
				subagents: { kind: "thread", level: "inherit" },
				background: { pick: null, titlesEnabled: true, overrides: {} },
			})
			expect(f.get().subagents.allowed).toEqual([{ kind: "thread", levels: ["default"] }])
		}
		it("a model takes every pick of it along", async () => {
			const f = await everywhere()
			await f.call("deleteConfiguredModel", { expectedRevision: 2, modelId: "m" })
			expect(f.get().models.map((row) => row.id)).toEqual(["n"])
			clearedEverywhere(f)
		})
		it("a connection takes its models and their picks along", async () => {
			const f = await everywhere()
			await f.call("deleteConnection", { expectedRevision: 2, connectionId: "c" })
			expect(f.get().connections).toEqual([])
			expect(f.get().models).toEqual([])
			clearedEverywhere(f)
		})
		it("turning a model off clears its picks in the same save, and on again doesn't bring them back", async () => {
			const f = await everywhere()
			const row = f.get().models[0]
			await f.call("saveConfiguredModels", { expectedRevision: 2, models: [{ ...row, enabled: false }] })
			expect(f.get().models[0].enabled).toBe(false)
			clearedEverywhere(f)
			await f.call("saveConfiguredModels", { expectedRevision: 3, models: [{ ...row }] })
			expect(f.get().models[0].enabled).toBeUndefined()
			expect(f.get().roles.chat).toBeNull()
		})
		it("a duplicate of a model that's off starts on", async () => {
			const f = await everywhere()
			const row = f.get().models[0]
			await f.call("saveConfiguredModels", { expectedRevision: 2, models: [{ ...row, enabled: false }] })
			const { draft } = (await f.call("duplicateConfiguredModel", { modelId: "m" })) as { draft: ModelRow }
			expect(draft).not.toHaveProperty("enabled")
		})
	})
})

describe("Phase 4 host boundaries", () => {
	it("rejects writes with rollout disabled before accessing the store", async () => {
		await expect(mutateSettings({} as never, "deleteConnection", "{}", false)).rejects.toThrow("disabled")
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
	it("saved threads are counted and don't block a removal, and the removed pick itself won't resolve", async () => {
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
		await f.call("deleteConfiguredModel", { expectedRevision: 2, modelId: "m" })
		expect(() => resolveConfiguredPick(f.get(), resolveThreadPick(selection, "act"))).toThrow(/was removed\. Pick another/)
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
		"setModelRoles",
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
			setModelRoles: { expectedRevision: 2, roles: { ...f.get().roles, chat: { modelId: "m", levelId: "default" } } },
			makeModelDefault: { expectedRevision: 2, mode: "act", pick: { modelId: "m", levelId: "default" } },
		}
		await expect(f.call(operation, cases[operation])).rejects.toThrow()
		expect(f.get().revision).toBe(2)
	})
})

describe("a connection outside the organization's allowlist", () => {
	const row = (id: string, connectionId: string) => ({
		id,
		connectionId,
		upstreamId: id,
		name: "",
		kind: "chat",
		overrides: {},
		providerOptions: {},
	})
	/** A migrated connection from before the policy, with Chat running on it, beside one that's allowed. */
	const seeded = async () => {
		const f = fixture()
		const allowed = {
			...createCompatibleConnection("ok"),
			kind: "provider" as const,
			providerId: "anthropic",
			options: {},
			secretRefs: {},
		}
		delete (allowed as { apiFormat?: unknown }).apiFormat
		delete (allowed as { azureApiVersion?: unknown }).azureApiVersion
		await f.call("saveConnection", { expectedRevision: 0, connection: createCompatibleConnection("old") })
		await f.call("saveConnection", { expectedRevision: 1, connection: allowed })
		await f.call("saveConfiguredModels", { expectedRevision: 2, models: [row("gone", "old"), row("fine", "ok")] })
		await f.call("setModelRoles", {
			expectedRevision: 3,
			roles: { ...f.get().roles, chat: { modelId: "gone", levelId: "default" } },
		})
		f.managed.remoteConfiguredProviders = ["anthropic"]
		return f
	}
	it("doesn't block edits to anything else", async () => {
		const f = await seeded()
		await f.call("saveConfiguredModels", { expectedRevision: 4, models: [{ ...row("fine", "ok"), name: "Renamed" }] })
		await f.call("setSubagentPolicy", { expectedRevision: 5, subagents: { ...f.get().subagents, maxConcurrent: 2 } })
		await f.call("saveConnection", { expectedRevision: 6, connection: { id: "ok", name: "Renamed" } })
		expect(f.get().revision).toBe(7)
	})
	it("can be deleted while a role still points at it", async () => {
		const f = await seeded()
		await f.call("deleteConnection", { expectedRevision: 4, connectionId: "old" })
		expect(f.get().connections.map((c) => c.id)).toEqual(["ok"])
		expect(f.get().roles.chat).toBeNull()
	})
	it("still can't be picked, edited, added to or tested", async () => {
		const f = await seeded()
		await expect(f.call("saveConnection", { expectedRevision: 4, connection: { id: "old", name: "x" } })).rejects.toThrow(
			/not allowed/,
		)
		await expect(f.call("saveConfiguredModels", { expectedRevision: 4, models: [row("more", "old")] })).rejects.toThrow(
			/not allowed/,
		)
		await f.call("makeModelDefault", { expectedRevision: 4, mode: "act", pick: { modelId: "fine", levelId: "default" } })
		await expect(
			f.call("makeModelDefault", { expectedRevision: 5, mode: "act", pick: { modelId: "gone", levelId: "default" } }),
		).rejects.toThrow(/not allowed/)
		await expect(
			f.call("setSubagentPolicy", {
				expectedRevision: 5,
				subagents: { ...f.get().subagents, allowed: [{ kind: "model", modelId: "gone", levels: ["default"] }] },
			}),
		).rejects.toThrow(/not allowed/)
		await expect(
			assertConfiguredModelRequestAllowed(f.state as never, f.get(), { modelId: "gone", levelId: "default" }),
		).rejects.toThrow(/organization/)
	})
	it("a role already outside a locked model ID doesn't block other edits, but moving to one is refused", async () => {
		const f = await seeded()
		f.managed.remoteConfiguredProviders = []
		f.managed.actModeOpenAiModelId = "managed-model"
		await f.call("saveConfiguredModels", { expectedRevision: 4, models: [{ ...row("fine", "ok"), name: "Renamed" }] })
		await f.call("saveConfiguredModels", { expectedRevision: 5, models: [row("wrong", "old")] })
		await expect(
			f.call("makeModelDefault", { expectedRevision: 6, mode: "act", pick: { modelId: "wrong", levelId: "default" } }),
		).rejects.toThrow(/managed/)
	})
})

describe("a value the organization locks", () => {
	const row = { id: "m", connectionId: "c", upstreamId: "test", name: "", kind: "chat", overrides: {}, providerOptions: {} }
	const pick = { modelId: "m", levelId: "default" }
	const compatible = async () => {
		const f = fixture()
		const connection = createCompatibleConnection("c")
		connection.baseUrl = "https://mine.invalid"
		connection.headers = [{ id: "h", name: "X-Mine", storage: "plain", value: "mine" }]
		await f.call("saveConnection", { expectedRevision: 0, connection })
		await f.call("saveConfiguredModels", { expectedRevision: 1, models: [row] })
		return f
	}
	it("a stored copy takes the managed value at request time instead of failing", async () => {
		const f = await compatible()
		f.managed.openAiBaseUrl = "https://managed.invalid"
		f.managed.azureApiVersion = "2024-01"
		f.managed.openAiHeaders = { "X-Org": "locked" }
		await expect(assertConfiguredModelRequestAllowed(f.state as never, f.get(), pick)).resolves.toBeUndefined()
		const { connection } = resolveEffectiveConfiguredPick(f.state as never, f.get(), pick)
		expect(connection.baseUrl).toBe("https://managed.invalid")
		expect(connection).toMatchObject({ azureApiVersion: "2024-01" })
		expect(connection.headers).toEqual([expect.objectContaining({ name: "X-Org", value: "locked" })])
		expect(f.get().connections[0].baseUrl).toBe("https://mine.invalid")
	})
	it("saving the correct managed value succeeds; any other is still refused", async () => {
		const f = await compatible()
		f.managed.openAiBaseUrl = "https://managed.invalid"
		f.managed.openAiHeaders = { "X-Org": "locked" }
		await expect(
			f.call("saveConnection", { expectedRevision: 2, connection: { id: "c", baseUrl: "https://other.invalid" } }),
		).rejects.toThrow(/managed/)
		await f.call("saveConnection", { expectedRevision: 2, connection: { id: "c", baseUrl: "https://managed.invalid" } })
		await f.call("saveConnection", {
			expectedRevision: 3,
			connection: { id: "c", headers: [{ id: "h", name: "x-org", storage: "plain", value: "locked" }] },
		})
		expect(f.get().connections[0].baseUrl).toBe("https://managed.invalid")
		await expect(
			f.call("saveConnection", {
				expectedRevision: 4,
				connection: { id: "c", headers: [{ id: "h", name: "x-org", storage: "plain", value: "mine" }] },
			}),
		).rejects.toThrow(/managed/)
	})
	it("an edit that leaves a stale locked value alone goes through", async () => {
		const f = await compatible()
		f.managed.openAiBaseUrl = "https://managed.invalid"
		await f.call("saveConnection", { expectedRevision: 2, connection: { id: "c", name: "Renamed" } })
		expect(f.get().connections[0].name).toBe("Renamed")
	})
	it("a new connection starts on the managed values and needs none of its own", async () => {
		const f = fixture()
		f.managed.openAiBaseUrl = "https://managed.invalid"
		f.managed.azureApiVersion = "2024-01"
		f.managed.openAiHeaders = { "X-Org": "locked" }
		const connection = createCompatibleConnection("c")
		connection.baseUrl = "https://typed.invalid"
		await f.call("saveConnection", { expectedRevision: 0, connection })
		expect(f.get().connections[0]).toMatchObject({
			baseUrl: "https://managed.invalid",
			azureApiVersion: "2024-01",
			headers: [],
		})
		await f.call("saveConfiguredModels", { expectedRevision: 1, models: [row] })
		await expect(assertConfiguredModelRequestAllowed(f.state as never, f.get(), pick)).resolves.toBeUndefined()
	})
	it.each([
		["bedrock", { awsRegion: "us-east-1", awsBedrockEndpoint: "https://vpc.invalid" }, { awsUseCrossRegionInference: true }],
		["vertex", { vertexProjectId: "p", vertexRegion: "r" }, {}],
		["litellm", { liteLlmBaseUrl: "https://lite.invalid" }, {}],
	] as const)("a %s connection takes managed keys it doesn't have", async (providerId, options, modelOptions) => {
		const f = fixture()
		await f.call("saveConnection", {
			expectedRevision: 0,
			connection: {
				id: "c",
				name: "",
				kind: "provider",
				providerId,
				baseUrl: null,
				auth: { kind: "none" },
				headers: [],
				requestTimeoutMs: null,
				defaults: {},
				options: {},
				secretRefs: {},
			},
		})
		await f.call("saveConfiguredModels", { expectedRevision: 1, models: [row] })
		Object.assign(f.managed, options, modelOptions)
		await expect(assertConfiguredModelRequestAllowed(f.state as never, f.get(), pick)).resolves.toBeUndefined()
		const resolved = resolveEffectiveConfiguredPick(f.state as never, f.get(), pick)
		expect(resolved.connection).toMatchObject({ options })
		expect(resolved.model.providerOptions).toMatchObject(modelOptions)
	})
	it("a managed key this settings store has no field for still fails closed", async () => {
		const f = fixture()
		await f.call("saveConnection", {
			expectedRevision: 0,
			connection: {
				id: "c",
				name: "",
				kind: "provider",
				providerId: "bedrock",
				baseUrl: null,
				auth: { kind: "none" },
				headers: [],
				requestTimeoutMs: null,
				defaults: {},
				options: {},
				secretRefs: {},
			},
		})
		await f.call("saveConfiguredModels", { expectedRevision: 1, models: [row] })
		f.managed.awsSomethingNew = "x"
		await expect(assertConfiguredModelRequestAllowed(f.state as never, f.get(), pick)).rejects.toThrow(/organization/)
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
	it("projects managed cache policy and runs on the organization URL at request time", async () => {
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
		).resolves.toBeUndefined()
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

describe("flagged migrated rows", () => {
	const flagged = (f: ReturnType<typeof fixture>, connection: object, upstreamId: string) => {
		const settings = f.get()
		settings.connections.push({ ...createCompatibleConnection("c"), auth: { kind: "none" }, ...connection })
		settings.models.push({
			id: "m",
			connectionId: "c",
			upstreamId,
			name: "m",
			kind: "unknown",
			overrides: {},
			providerOptions: {},
		})
		settings.roles.chat = { modelId: "m", levelId: "default" }
	}
	it("point availability and the role at the model ID field", async () => {
		const f = fixture()
		flagged(f, { baseUrl: "https://a.test/v1" }, MODEL_ID_NEEDED)
		const state = await readModelSettingsState(f.state as never)
		const target = { page: "models", modelId: "m", field: "upstreamId" }
		expect(state.availability.m).toMatchObject({ available: false, target })
		expect(state.availability["role.chat"]).toMatchObject({ available: false, target })
	})
	it("point availability and the role at the base URL field", async () => {
		const f = fixture()
		flagged(f, { baseUrl: BASE_URL_NEEDED }, "real")
		const state = await readModelSettingsState(f.state as never)
		const target = { page: "models", connectionId: "c", field: "baseUrl" }
		expect(state.availability.m).toMatchObject({ available: false, target })
		expect(state.availability["role.chat"]).toMatchObject({ available: false, target })
	})
	it("publish the migration's issues with its status", async () => {
		const f = fixture()
		const issues = [{ kind: "normalized", field: "modelId", source: "blank", modelId: "m" }]
		f.state.getModelSettingsMigrationStatus = () => ({ status: "complete", retryable: false, issues }) as never
		expect((await readModelSettingsState(f.state as never)).migration.issues).toEqual(issues)
	})
})

describe("migrated values stay out of Changed until edited", () => {
	const ladder = [
		{ id: "default", label: "Default", rank: 0, request: { kind: "default" as const } },
		{ id: "high", label: "high", rank: 1, request: { kind: "effort" as const, value: "high" } },
	]
	const migrated = () => {
		const f = fixture()
		const settings = f.get()
		settings.connections.push({ ...createCompatibleConnection("c"), baseUrl: "https://a.test/v1", auth: { kind: "none" } })
		settings.models.push({
			id: "m",
			connectionId: "c",
			upstreamId: "m",
			name: "m",
			kind: "unknown",
			overrides: { levels: ladder, reasoning: "yes", temperature: 0.2 },
			providerOptions: {},
			migratedValues: ["levels", "reasoning"],
		})
		return f
	}
	const row = (f: ReturnType<typeof fixture>) => f.get().models.find((m) => m.id === "m")!
	const saveRow = (f: ReturnType<typeof fixture>, change: Partial<ModelRow>) =>
		f.call("saveConfiguredModels", { expectedRevision: f.get().revision, models: [{ ...row(f), ...change }] })

	it("an unrelated save keeps the marker", async () => {
		const f = migrated()
		await saveRow(f, { name: "renamed" })
		expect(row(f).migratedValues).toEqual(["levels", "reasoning"])
	})
	it("editing a value makes that one the user's", async () => {
		const f = migrated()
		await saveRow(f, { overrides: { ...row(f).overrides, levels: [ladder[0]] } })
		expect(row(f).migratedValues).toEqual(["reasoning"])
		await saveRow(f, { overrides: { temperature: 0.2 } })
		expect(row(f).migratedValues).toBeUndefined()
	})
	it("a save can't claim a marker the stored row doesn't have, and a new row never has one", async () => {
		const f = migrated()
		await saveRow(f, { overrides: { ...row(f).overrides, levels: [ladder[0]] } })
		await saveRow(f, { migratedValues: ["levels", "reasoning"] })
		expect(row(f).migratedValues).toEqual(["reasoning"])
		await f.call("saveConfiguredModels", {
			expectedRevision: f.get().revision,
			models: [{ ...row(f), id: "copy", migratedValues: ["levels"] }],
		})
		expect(f.get().models.find((m) => m.id === "copy")?.migratedValues).toBeUndefined()
	})
	it("a shared default replaces the migrated value, so the model follows it, and leaves the user's own", async () => {
		const f = migrated()
		await f.call("saveConnection", {
			expectedRevision: f.get().revision,
			connection: { id: "c", defaults: { levels: [ladder[0]] } },
			secrets: [],
		})
		expect(row(f).overrides.levels).toBeUndefined()
		expect(row(f).overrides.reasoning).toBe("yes")
		expect(row(f).overrides.temperature).toBe(0.2)
		expect(row(f).migratedValues).toEqual(["reasoning"])
		await f.call("saveConnection", {
			expectedRevision: f.get().revision,
			connection: { id: "c", defaults: { temperature: 0.9 } },
			secrets: [],
		})
		expect(row(f).overrides.temperature).toBe(0.2)
	})
})
