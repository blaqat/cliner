import {
	createCompatibleConnection,
	createDefaultModelSettings,
	type ModelSettings,
	ModelSettingsMigrationSchema,
	ModelSettingsSchema,
} from "@shared/model-settings"
import { Empty } from "@shared/proto/cline/common"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { connectProviderKey } from "@/core/controller/models/connectProviderKey"
import { resetState } from "@/core/controller/state/resetState"
import { updateSettings } from "@/core/controller/state/updateSettings"
import { migrateModelSettings } from "@/core/storage/model-settings-migration"
import { resetGlobalState } from "@/core/storage/utils/state-helpers"
import { AuthService as SdkAuthService } from "../auth-service"
import { Controller as SdkController } from "../SdkController"
import { InMemoryConnectionSecretStore, VSCodeConnectionSecretStore } from "./connection-secret-store"
import { readModelSettingsState } from "./host-settings"
import { configuredActiveModel } from "./legacy-settings"

vi.mock("./rollout", () => ({ modelSettingsRolloutEnabled: () => true }))
vi.mock("@/shared/services/Logger", () => ({
	Logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() },
}))
const host = vi.hoisted(() => ({ state: undefined as unknown, showMessage: vi.fn() }))
vi.mock("@/core/storage/StateManager", () => ({ StateManager: { get: () => host.state } }))
vi.mock("@/hosts/host-provider", () => ({ HostProvider: { window: { showMessage: host.showMessage } } }))
const providerStore = vi.hoisted(() => ({ clear: vi.fn() }))
vi.mock("../provider-migration", async (original) => ({
	...(await original<typeof import("../provider-migration")>()),
	clearProviderCredentials: providerStore.clear,
}))

function fixture(status: "complete" | "prepared" = "complete") {
	let settings: ModelSettings | undefined = createDefaultModelSettings()
	const connectionSecrets = new InMemoryConnectionSecretStore()
	const global: Record<string, unknown> = { modelSettingsMigration: { status } }
	const written = {
		setGlobalState: vi.fn(),
		setGlobalStateBatch: vi.fn(),
		setApiConfiguration: vi.fn(),
		setSecret: vi.fn(),
		setSecretsBatch: vi.fn(),
	}
	const state = {
		...written,
		connectionSecrets,
		listSecretStorageKeys: () => [] as string[],
		setSecretsForKeys: vi.fn(async (_entries: Record<string, string | undefined>) => {}),
		getApiConfiguration: () => ({}),
		getGlobalSettingsKey: () => "act",
		getGlobalStateKey: (key: string) => (key === "modelSettings" ? settings : global[key]),
		getRemoteConfigSettings: () => ({}),
		getModelSettingsMigrationStatus: () => ({ status: "complete", retryable: false }),
		reInitialize: vi.fn(),
		mutateModelSettings: async (revision: number, mutate: (value: ModelSettings) => Promise<void>) => {
			if (revision !== settings?.revision) throw new Error("revision")
			const next = structuredClone(settings)
			await mutate(next)
			next.revision++
			settings = next
		},
	}
	host.state = state
	const providerStore = { write: vi.fn(), commitSelection: vi.fn(), read: vi.fn(() => ({})) }
	const controller = {
		stateManager: state,
		postStateToWebview: vi.fn(),
		handleApiConfigurationChanged: vi.fn(),
		getProviderConfigStore: () => providerStore,
		getProviderCatalog: () => ({ peekModels: () => undefined }),
	}
	return {
		controller,
		state,
		written,
		providerStore,
		connectionSecrets,
		get: () => settings as ModelSettings,
		set: (value: ModelSettings | undefined) => {
			settings = value
		},
	}
}

describe("settings writes with the new store in use", () => {
	it("a thread can't pick a model outside the organization's allowlist", async () => {
		const f = fixture()
		const settings = f.get()
		settings.connections.push(createCompatibleConnection("c"))
		settings.models.push({
			id: "m",
			connectionId: "c",
			upstreamId: "x",
			name: "",
			kind: "chat",
			overrides: {},
			providerOptions: {},
		})
		f.state.getRemoteConfigSettings = () => ({ remoteConfiguredProviders: ["anthropic"] }) as never
		await expect(
			SdkController.prototype.setConfiguredThreadSelection.call({ stateManager: f.state, task: undefined } as never, {
				taskId: "",
				mode: "act",
				pick: { modelId: "m", levelId: "default" },
				nextMessageOnly: false,
			}),
		).rejects.toThrow(/organization/)
	})
	it("keeps ordinary settings writable", async () => {
		const f = fixture()
		await expect(updateSettings(f.controller as never, { preferredLanguage: "French" } as never)).resolves.toEqual(
			Empty.create(),
		)
		expect(f.written.setGlobalState).toHaveBeenCalledWith("preferredLanguage", "French")
	})
})

describe("provider sign-in callbacks", () => {
	beforeEach(() => host.showMessage.mockClear())

	it("leaves a connection, a key and picks the runtime reads", async () => {
		const f = fixture()
		const { connectionId, picked } = await connectProviderKey(f.controller as never, "openrouter", "sk-or", true)
		const settings = f.get()
		const pick = { modelId: settings.models[0].id, levelId: "default" }
		expect(picked).toBe(true)
		expect(settings.connections[0]).toMatchObject({ id: connectionId, kind: "provider", providerId: "openrouter" })
		expect(settings.models[0].upstreamId).toBeTruthy()
		expect(settings.roles.chat).toEqual(pick)
		expect(settings.roles.background.pick).toEqual(pick)
		expect(await f.connectionSecrets.get(`settings:v1:connection:${connectionId}:apiKey`)).toBe("sk-or")
		expect(f.written.setApiConfiguration).not.toHaveBeenCalled()
		expect(f.controller.postStateToWebview).toHaveBeenCalled()
	})
	it("signing in again replaces the key and leaves the model running", async () => {
		const f = fixture()
		const { connectionId } = await connectProviderKey(f.controller as never, "openrouter", "sk-old", true)
		const chat = f.get().roles.chat
		await connectProviderKey(f.controller as never, "openrouter", "sk-new", true)
		expect(f.get().connections).toHaveLength(1)
		expect(f.get().models).toHaveLength(1)
		expect(f.get().roles.chat).toEqual(chat)
		expect(await f.connectionSecrets.get(`settings:v1:connection:${connectionId}:apiKey`)).toBe("sk-new")
	})
	it("moves Chat to the provider signed in to, keeping a model already there", async () => {
		const f = fixture()
		const { connectionId } = await connectProviderKey(f.controller as never, "openrouter", "sk", true)
		const signedIn = f.get().models[0].id
		const other = createCompatibleConnection("other")
		other.auth = { kind: "none" }
		const settings = f.get()
		settings.connections.push(other)
		settings.models.push({
			id: "m2",
			connectionId: "other",
			upstreamId: "x",
			name: "",
			kind: "chat",
			overrides: {},
			providerOptions: {},
		})
		settings.roles.chat = { modelId: "m2", levelId: "default" }
		await connectProviderKey(f.controller as never, "openrouter", "sk", true)
		expect(f.get().roles.chat?.modelId).toBe(signedIn)
		expect(f.get().connections.filter((c) => c.id === connectionId)).toHaveLength(1)
	})
	it("the auth service's callback writes the new store, and refuses without a window to do it in", async () => {
		const f = fixture()
		const service = SdkAuthService.prototype as never as {
			handleRequestyCallback: (code: string, controller?: unknown) => Promise<void>
			handleHicapCallback: (code: string, controller?: unknown) => Promise<void>
		}
		await service.handleRequestyCallback("requesty-key", f.controller)
		expect(f.written.setApiConfiguration).not.toHaveBeenCalled()
		expect(f.get().connections[0]).toMatchObject({ kind: "provider", providerId: "requesty" })
		expect(f.get().roles.chat).not.toBeNull()
		const ref = f.get().connections[0].auth
		expect(await f.connectionSecrets.get(ref.kind === "keychain" ? ref.secretRef : "")).toBe("requesty-key")
		await expect(service.handleHicapCallback("hicap-key")).rejects.toThrow(/window/)
		expect(f.written.setApiConfiguration).not.toHaveBeenCalled()
	})
	it("says so when a key is saved but no model can be picked, and picks nothing", async () => {
		const f = fixture()
		const { connectionId, picked } = await connectProviderKey(f.controller as never, "not-a-catalog-provider", "sk", true)
		expect(picked).toBe(false)
		expect(f.get().roles.chat).toBeNull()
		expect(await f.connectionSecrets.get(`settings:v1:connection:${connectionId}:apiKey`)).toBe("sk")
	})
})

describe("who reads the provider with the new store in use", () => {
	const seeded = () => {
		const f = fixture()
		const settings = f.get()
		const compatible = createCompatibleConnection("c")
		settings.connections.push(compatible, {
			...createCompatibleConnection("a"),
			kind: "provider",
			providerId: "cline",
			auth: { kind: "sdk-account", providerId: "cline" },
			options: {},
			secretRefs: {},
		} as never)
		settings.models.push(
			{ id: "m", connectionId: "c", upstreamId: "local", name: "", kind: "chat", overrides: {}, providerOptions: {} },
			{ id: "n", connectionId: "a", upstreamId: "paid", name: "", kind: "chat", overrides: {}, providerOptions: {} },
		)
		settings.roles.chat = { modelId: "m", levelId: "default" }
		return f
	}
	it("resolves the role, then the thread's pick, and never the old selection", () => {
		const f = seeded()
		expect(configuredActiveModel(f.state as never, "act")).toEqual({ providerId: "openai", modelId: "local" })
		const thread = { version: 1 as const, act: { modelId: "n", levelId: "default" }, ask: null }
		expect(configuredActiveModel(f.state as never, "act", thread)).toEqual({ providerId: "cline", modelId: "paid" })
		f.get().roles.chat = null
		expect(configuredActiveModel(f.state as never, "act")).toEqual({})
	})
	it("Cline-managed checks follow the thread's model, not a stale old provider", () => {
		const f = seeded()
		f.state.getApiConfiguration = () => ({ actModeApiProvider: "cline" })
		const stub = {
			stateManager: f.state,
			task: { taskId: "t" },
			getTaskSessionContext: () => ({ apiSelection: {} }),
			getActiveProviderId: (SdkController.prototype as never as { getActiveProviderId: unknown }).getActiveProviderId,
		}
		const read = () => (stub.getActiveProviderId as () => string | undefined).call(stub)
		expect(read()).toBe("openai")
		stub.getTaskSessionContext = () =>
			({
				apiSelection: { modelSelectionV1: { version: 1, act: { modelId: "n", levelId: "default" }, ask: null } },
			}) as never
		expect(read()).toBe("cline")
	})
})

describe("reset", () => {
	const stored = async () => {
		const f = fixture()
		const connection = createCompatibleConnection("c")
		f.get().connections.push(connection)
		await f.connectionSecrets.set(connection.auth.kind === "keychain" ? connection.auth.secretRef : "", "named")
		await f.connectionSecrets.set("settings:v1:connection:merged-away:apiKey", "orphan")
		return f
	}
	it("removes the keys, including ones no connection names, and the store", async () => {
		const f = await stored()
		await readModelSettingsState(f.state as never)
		await resetGlobalState()
		expect(await f.connectionSecrets.list()).toEqual([])
		expect(f.written.setGlobalState).toHaveBeenCalledWith("modelSettings", undefined)
		expect(f.written.setGlobalState).toHaveBeenCalledWith("modelSettingsMigration", undefined)
		expect(f.written.setGlobalState).toHaveBeenCalledWith("modelSettingsBackupV1", undefined)
		expect(f.state.reInitialize).toHaveBeenCalled()
	})
	it("clears the keys in providers.json before the settings that retry it", async () => {
		const f = await stored()
		providerStore.clear.mockClear()
		providerStore.clear.mockImplementationOnce(() => {
			throw new Error("disk full")
		})
		await expect(resetGlobalState()).rejects.toThrow("disk full")
		expect(f.written.setGlobalState).not.toHaveBeenCalled()
		await resetGlobalState()
		expect(providerStore.clear).toHaveBeenCalledTimes(2)
		expect(f.written.setGlobalState).toHaveBeenCalledWith("modelSettings", undefined)
	})
	it("clears the saved configurations' own keys", async () => {
		const f = await stored()
		f.state.listSecretStorageKeys = () => ["profile:a:openAiApiKey", "profile:b:apiKey", "openAiApiKey"]
		await resetGlobalState()
		expect(f.state.setSecretsForKeys).toHaveBeenCalledWith({
			"profile:a:openAiApiKey": undefined,
			"profile:b:apiKey": undefined,
		})
	})
	it("leaves a clean first run: moving doesn't run again and bring the shared stores back", async () => {
		const f = await stored()
		await resetGlobalState()
		const data: Record<string, unknown> = {}
		for (const [key, value] of f.written.setGlobalState.mock.calls as Array<[string, unknown]>) data[key] = value
		expect(Object.keys(data)).toContain("apiConfigProfiles")
		const sdkInput = vi.fn(async () => ({
			providers: { lastUsedProvider: "anthropic", providers: { anthropic: { settings: { model: "claude" } } } },
		}))
		const result = await migrateModelSettings({
			state: {
				keys: () => Object.keys(data),
				get: (key: string) => data[key],
				update: async (key: string, value: unknown) => {
					data[key] = value
				},
			} as never,
			legacySecretKeys: [],
			readLegacySecret: () => undefined,
			sdkInput,
		})
		expect(result).toBe("complete")
		expect(sdkInput).not.toHaveBeenCalled()
		const settings = data.modelSettings as ModelSettings
		expect(ModelSettingsSchema.parse(settings).models).toEqual([])
		expect(settings.connections).toEqual([])
		expect(settings.roles.chat).toBeNull()
		expect(ModelSettingsMigrationSchema.safeParse(data.modelSettingsMigration).success).toBe(true)
	})
	it("keeps the settings when the keychain refuses, so it can be retried", async () => {
		const f = await stored()
		f.connectionSecrets.delete = vi.fn().mockRejectedValue(new Error("keychain locked"))
		await expect(resetGlobalState()).rejects.toThrow("keychain locked")
		expect(f.written.setGlobalState).not.toHaveBeenCalled()
		expect(f.state.reInitialize).not.toHaveBeenCalled()
	})
	it("says what the reset removed", async () => {
		const f = await stored()
		const deauth = vi.spyOn(SdkAuthService.prototype, "handleDeauth").mockResolvedValue()
		const codex = vi.spyOn(SdkAuthService.prototype, "clearCodexCredentials").mockResolvedValue()
		const info = vi.spyOn(SdkAuthService.prototype, "getInfo").mockReturnValue({ user: { uid: "u" } } as never)
		await resetState({ postStateToWebview: vi.fn() } as never, { global: true } as never)
		expect(deauth).toHaveBeenCalledOnce()
		expect(codex).toHaveBeenCalledOnce()
		for (const spy of [deauth, codex, info]) spy.mockRestore()
		const said = host.showMessage.mock.calls.map(([call]) => call?.message).join(" ")
		expect(said).toMatch(/connection/i)
		expect(said).toMatch(/keys/i)
		expect(await f.connectionSecrets.list()).toEqual([])
	})
	it("the VS Code store remembers its references across instances, since VS Code can't list them", async () => {
		const values = new Map<string, string>()
		const storage = {
			get: async (key: string) => values.get(key),
			store: async (key: string, value: string) => void values.set(key, value),
			delete: async (key: string) => void values.delete(key),
		} as never
		const store = new VSCodeConnectionSecretStore(storage)
		await Promise.all(["a", "b", "c"].map((id) => store.set(`settings:v1:connection:${id}:apiKey`, id)))
		await store.delete("settings:v1:connection:b:apiKey")
		expect((await new VSCodeConnectionSecretStore(storage).list()).sort()).toEqual([
			"settings:v1:connection:a:apiKey",
			"settings:v1:connection:c:apiKey",
		])
	})
})
