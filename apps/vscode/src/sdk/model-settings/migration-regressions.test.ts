import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createGateway } from "@cline/llms"
import { type ModelSettings, ModelSettingsMigrationSchema } from "@shared/model-settings"
import { SecretKeys } from "@shared/storage/state-keys"
import { describe, expect, it, vi } from "vitest"
import { resolveTaskApiSelection } from "@/core/controller/models/apiProfiles"
import { migrateModelSettings, redactedMigrationCause } from "@/core/storage/model-settings-migration"
import { toSdkProviderId } from "@/sdk/model-catalog/sdk-provider-id"
import { migrateThreadModelSelection, resolveConfiguredPick, resolveThreadPick } from "../model-settings-resolver"
import { InMemoryConnectionSecretStore } from "./connection-secret-store"
import { providerSecretFields } from "./provider-options"
import { resolveConnectionConfig } from "./request-adapter"
import { readSdkMigrationInput } from "./sdk-migration-input"

// resolveTaskApiSelection reads the real switch; the flag itself stays off everywhere else.
vi.mock("./rollout", () => ({ MODEL_SETTINGS_ROLLOUT_ENABLED: true, modelSettingsRolloutEnabled: () => true }))

type Journal = { status: string; issues?: Array<Record<string, string>> } & Record<string, unknown>
function fixture(seed: Record<string, unknown>, keys: Record<string, string> = {}) {
	const data: Record<string, any> = structuredClone(seed)
	const writes: string[] = []
	const secrets = new InMemoryConnectionSecretStore()
	const state = {
		keys: () => Object.keys(data),
		get: (k: string) => structuredClone(data[k]),
		update: async (k: string, v: unknown) => {
			writes.push(k)
			data[k] = structuredClone(v)
		},
	}
	const deps = {
		state: state as never,
		secrets,
		legacySecretKeys: Object.keys(keys),
		readLegacySecret: (k: string) => keys[k],
	}
	return {
		data,
		deps,
		keys,
		secrets,
		writes,
		run: () => migrateModelSettings(deps),
		settings: () => data.modelSettings as ModelSettings,
		journal: () => data.modelSettingsMigration as Journal,
		rowOf: (upstreamId: string) => (data.modelSettings as ModelSettings).models.find((m) => m.upstreamId === upstreamId)!,
		store: { getGlobalStateKey: (k: string) => data[k] } as never,
	}
}
const profile = (id: string, modelId: string, extra: Record<string, unknown> = {}) => ({
	id,
	name: id,
	provider: "openai",
	modelId,
	options: { openAiBaseUrl: "https://a.test/v1" },
	...extra,
})
const base = () => ({
	apiConfigProfiles: [profile("p1", "m1"), profile("p2", "m2")],
	askProfileId: "p1",
	actProfileId: "p1",
	actModeApiProvider: "openai",
	planModeApiProvider: "openai",
	actModeOpenAiModelId: "m1",
	planModeOpenAiModelId: "m1",
})
const keys = () => ({ "profile:p1:openAiApiKey": "K1", "profile:p2:openAiApiKey": "K2", openAiApiKey: "GLOBAL" })

describe("a moved temperature of 0", () => {
	const withInfo = (temperature: number, extra: Record<string, unknown> = {}) => ({
		apiConfigProfiles: [
			profile("p1", "m1", { options: { openAiBaseUrl: "https://a.test/v1", planModeOpenAiModelInfo: { temperature } } }),
			profile("p2", "m2", { options: { openAiBaseUrl: "https://a.test/v1", planModeOpenAiModelInfo: { temperature } } }),
		],
		...extra,
	})
	it("isn't carried over, because the old path never sent it", async () => {
		const f = fixture(withInfo(0), keys())
		await f.run()
		for (const row of f.settings().models) expect(row.overrides).not.toHaveProperty("temperature")
		for (const connection of f.settings().connections) expect(connection.defaults).not.toHaveProperty("temperature")
	})
	it("keeps a value the old path did send", async () => {
		const f = fixture(withInfo(0.7), keys())
		await f.run()
		const connection = f.settings().connections[0]
		expect(f.rowOf("m1").overrides.temperature ?? connection.defaults.temperature).toBe(0.7)
	})
	it("is cleared once from settings already moved, and a 0 chosen later stays", async () => {
		const f = fixture(base(), keys())
		await f.run()
		const moved = f.settings()
		moved.models[0].overrides.temperature = 0
		moved.models[1].overrides.temperature = 0.4
		moved.connections[0].defaults.temperature = 0
		const before = moved.revision
		f.data.modelSettingsMigration = { ...f.data.modelSettingsMigration, repairs: undefined }
		await f.run()
		expect(f.settings().models[0].overrides).not.toHaveProperty("temperature")
		expect(f.settings().models[1].overrides.temperature).toBe(0.4)
		expect(f.settings().connections[0].defaults).not.toHaveProperty("temperature")
		expect(f.settings().revision).toBe(before + 1)
		f.settings().models[0].overrides.temperature = 0
		await f.run()
		expect(f.settings().models[0].overrides.temperature).toBe(0)
	})
	it("leaves a model you added yourself alone", async () => {
		const f = fixture(base(), keys())
		await f.run()
		const own = { ...structuredClone(f.settings().models[0]), id: "mine", overrides: { temperature: 0 } }
		f.settings().models.push(own)
		f.data.modelSettingsMigration = { ...f.data.modelSettingsMigration, repairs: undefined }
		await f.run()
		expect(f.settings().models.find((row) => row.id === "mine")?.overrides.temperature).toBe(0)
	})
})

describe("M1: a complete journal is final", () => {
	it("brings nothing back after delete, key rotation or legacy edits, and writes nothing", async () => {
		const f = fixture(base(), keys())
		await f.run()
		const edited = f.settings()
		edited.models = edited.models.filter((m) => m.upstreamId !== "m2")
		edited.connections = edited.connections.filter((c) => edited.models.some((m) => m.connectionId === c.id))
		const connection = edited.connections[0]
		if (connection.auth.kind !== "keychain") throw new Error("expected keychain")
		await f.secrets.set(connection.auth.secretRef, "ROTATED")
		f.data.modelSettings = edited
		f.data.actModeReasoningEffort = "low"
		f.data.threadTitlesEnabled = true
		f.data.apiConfigProfiles.push(profile("p3", "m3"))
		f.keys["profile:p1:openAiApiKey"] = "OLD-REVOKED"
		f.deps.legacySecretKeys = Object.keys(f.keys)
		const before = structuredClone(f.data)
		const set = vi.spyOn(f.secrets, "set")
		f.writes.length = 0

		const sdkInput = vi.fn(async () => ({}))
		expect(await migrateModelSettings({ ...f.deps, sdkInput })).toBe("complete")

		expect(f.data).toEqual(before)
		expect(f.writes).toEqual([])
		expect(set).not.toHaveBeenCalled()
		expect(sdkInput).not.toHaveBeenCalled()
		expect(await f.secrets.get(connection.auth.secretRef)).toBe("ROTATED")
	})
	it("never moves a complete journal back to prepared when the keychain fails", async () => {
		const f = fixture(base(), keys())
		await f.run()
		f.secrets.set = async () => {
			throw new Error("keychain locked")
		}
		f.data.actModeReasoningEffort = "low"
		await f.run()
		expect(f.journal().status).toBe("complete")
	})
})

describe("M2: roles match legacy resolution", () => {
	const threadDefault = {
		apiConfigProfiles: [profile("c", "m")],
		profiles: [{ id: "pf", name: "pf", configurationId: "c", reasoningEffort: "high" }],
		threadDefaultProfileId: "pf",
		actProfileId: "c",
		askProfileId: "c",
	}
	const roles = async (seed: Record<string, unknown>) => {
		const f = fixture(seed)
		await f.run()
		return f.settings().roles
	}
	it("adds no commit message override that only repeats Background text", async () => {
		const { settings, run } = fixture(threadDefault)
		await run()
		expect(settings().roles.background.overrides).toEqual({})
	})
	it("applies the thread default to both modes and leaves Ask off", async () => {
		const { chat, ask } = await roles(threadDefault)
		expect(chat?.levelId).toBe("high")
		expect(ask.enabled).toBe(false)
		expect(ask.pick).toEqual(chat)
	})
	it("falls back to the thread default in separate mode with unset thread IDs", async () => {
		const { chat, ask } = await roles({ ...threadDefault, threadSeparateAskActProfiles: true })
		expect(chat?.levelId).toBe("high")
		expect(ask.pick?.levelId).toBe("high")
		expect(ask.enabled).toBe(false)
	})
	it("ignores a separate-mode thread pick when separate mode is off", async () => {
		const { chat } = await roles({
			...threadDefault,
			apiConfigProfiles: [profile("c", "m"), profile("d", "n")],
			profiles: [...threadDefault.profiles, { id: "other", configurationId: "d" }],
			threadActProfileId: "other",
			threadAskProfileId: "other",
		})
		expect(chat?.levelId).toBe("high")
	})
	it("keeps the global effort when there is no thread default", async () => {
		const { chat, ask } = await roles({ ...base(), actModeReasoningEffort: "xhigh" })
		expect(chat?.levelId).toBe("xhigh")
		expect(ask.enabled).toBe(false)
	})
	it("turns Different model for Ask on only for a real difference", async () => {
		const models = await roles({ ...base(), askProfileId: "p2" })
		expect(models.ask.enabled).toBe(true)
		const separate = await roles({
			...threadDefault,
			apiConfigProfiles: [profile("c", "m"), profile("d", "n")],
			profiles: [...threadDefault.profiles, { id: "fast", configurationId: "d" }],
			threadSeparateAskActProfiles: true,
			threadActProfileId: "pf",
			threadAskProfileId: "fast",
		})
		expect(separate.ask.enabled).toBe(true)
		expect(separate.chat?.levelId).toBe("high")
		const chosenLevels = await roles({ ...base(), actModeReasoningEffort: "high", planModeReasoningEffort: "low" })
		expect(chosenLevels.ask).toMatchObject({ enabled: true, pick: { levelId: "low" } })
		const sameBothWays = await roles({
			...threadDefault,
			threadSeparateAskActProfiles: true,
			threadAskProfileId: "pf",
			threadActProfileId: "pf",
		})
		expect(sameBothWays.ask.enabled).toBe(false)
	})
	it("falls back past a stale thread default to the assignment", async () => {
		const { chat } = await roles({ ...base(), threadDefaultProfileId: "gone", actModeReasoningEffort: "medium" })
		expect(chat?.levelId).toBe("medium")
	})
})

describe("M3: saved efforts never stop a migrated thread", () => {
	it("offers the standard ladder on an unknown model with a saved effort, not only that effort", async () => {
		const f = fixture(base(), keys())
		await f.run()
		const row = f.rowOf("m1")
		expect(row.overrides.levels).toBeUndefined()
		const f2 = fixture(
			{
				...base(),
				modelProfiles: [{ id: "deep", name: "Deep", configurationId: "p1", reasoningEffort: "high" }],
			},
			keys(),
		)
		await f2.run()
		const resolved = resolveConfiguredPick(f2.settings(), { modelId: f2.rowOf("m1").id, levelId: "high" })
		expect(resolved.values.levels.map((l) => l.id)).toEqual(["default", "low", "medium", "high", "xhigh"])
	})
	it("offers an assigned model the ladder when its mode ran at a saved effort", async () => {
		const f = fixture({ ...base(), actModeReasoningEffort: "high" }, keys())
		await f.run()
		expect(f.settings().roles.chat).toEqual({ modelId: f.rowOf("m1").id, levelId: "high" })
		expect(resolveConfiguredPick(f.settings(), f.settings().roles.chat!).levelId).toBe("high")
	})
	it("runs a thread whose effort no configuration saved, at Default, rather than refuse it", async () => {
		const f = fixture(base(), keys())
		await f.run()
		const thread = migrateThreadModelSelection(
			{ actProfileId: "p1", actModeReasoningEffort: "high" },
			f.journal() as never,
			f.settings(),
		)
		expect(resolveConfiguredPick(f.settings(), resolveThreadPick(thread, "act")).levelId).toBe("default")
	})
	it("falls a thread's unrecorded mode back to the current selection", async () => {
		const f = fixture({ ...base(), askProfileId: "p2", planModeReasoningEffort: "low" }, keys())
		await f.run()
		const settings = f.settings()
		const onlyAct = migrateThreadModelSelection({ actProfileId: "p1" }, f.journal() as never, settings)
		expect(resolveThreadPick(onlyAct, "plan")).toEqual(settings.roles.ask.pick)
		expect(resolveConfiguredPick(settings, resolveThreadPick(onlyAct, "plan")).model.upstreamId).toBe("m2")
		const effortOnly = migrateThreadModelSelection({ actModeReasoningEffort: "high" }, f.journal() as never, settings)
		expect(resolveThreadPick(effortOnly, "act")).toEqual({ modelId: f.rowOf("m1").id, levelId: "default" })
	})
	it("offers only the default on a model known not to reason, and moves the saved effort to it", async () => {
		const known = createGateway()
			.listModels("openai-native")
			.find((m) => !m.capabilities?.includes("reasoning"))
		expect(known).toBeDefined()
		const f = fixture({
			apiConfigProfiles: [{ id: "a", name: "a", provider: "openai-native", modelId: known!.id, reasoningEffort: "high" }],
			actProfileId: "a",
			askProfileId: "a",
			actModeReasoningEffort: "high",
		})
		await f.run()
		const row = f.rowOf(known!.id)
		expect(row.overrides.levels).toBeUndefined()
		expect(f.settings().roles.chat).toEqual({ modelId: row.id, levelId: "default" })
		const thread = migrateThreadModelSelection(
			{ actProfileId: "a", actModeReasoningEffort: "high" },
			f.journal() as never,
			f.settings(),
		)
		expect(resolveConfiguredPick(f.settings(), resolveThreadPick(thread, "act")).levelId).toBe("default")
	})
	it("uses catalog levels on a known reasoning model and moves an unoffered effort down", async () => {
		const known = createGateway()
			.listModels("anthropic")
			.find((m) => m.capabilities?.includes("reasoning"))
		const f = fixture({
			apiConfigProfiles: [{ id: "a", name: "a", provider: "anthropic", modelId: known!.id }],
			actProfileId: "a",
			askProfileId: "a",
		})
		await f.run()
		const row = f.rowOf(known!.id)
		const offered = row.overrides.levels!.map((l) => l.id)
		expect(offered).toContain("high")
		expect(offered).not.toContain("not-a-level")
		const thread = migrateThreadModelSelection(
			{ actProfileId: "a", actModeReasoningEffort: "not-a-level" as never },
			f.journal() as never,
			f.settings(),
		)
		expect(resolveThreadPick(thread, "act")?.levelId).toBe("default")
	})
	it("migrates a Gemini thinking level as a real level", async () => {
		const f = fixture({
			apiConfigProfiles: [
				{
					id: "g",
					name: "g",
					provider: "gemini",
					modelId: "custom-gemini",
					options: { geminiActModeThinkingLevel: "deep" },
				},
			],
			actProfileId: "g",
			askProfileId: "g",
		})
		await f.run()
		expect(f.journal().status).toBe("complete")
		const level = f.rowOf("custom-gemini").overrides.levels!.find((l) => l.id === "deep")
		expect(level?.request).toEqual({ kind: "thinking-level", value: "deep" })
	})
})

describe("M10: keys, accounts and old threads", () => {
	it("names real secret keys for every provider", () => {
		const providers = [
			"anthropic",
			"openrouter",
			"openai",
			"openai-native",
			"cline",
			"deepseek",
			"gemini",
			"xai",
			"mistral",
			"groq",
			"cerebras",
			"sambanova",
			"fireworks",
			"together",
			"nebius",
			"moonshot",
			"qwen",
			"doubao",
			"minimax",
			"zai",
			"zai-coding-plan",
			"aihubmix",
			"requesty",
			"asksage",
			"baseten",
			"hicap",
			"nousResearch",
			"nousresearch",
			"wandb",
			"dify",
			"oca",
			"huggingface",
			"huawei-cloud-maas",
			"litellm",
			"vercel-ai-gateway",
			"ollama",
			"bedrock",
			"sapaicore",
		]
		for (const provider of providers) {
			const fields = providerSecretFields(toSdkProviderId(provider))
			expect(fields.length, provider).toBeGreaterThan(0)
			for (const field of fields) expect(SecretKeys as readonly string[], provider).toContain(field)
		}
		expect(providerSecretFields("openrouter")).toEqual(["openRouterApiKey"])
		for (const keyless of ["lmstudio", "vscode-lm", "vertex", "claude-code"])
			expect(providerSecretFields(keyless)).toEqual([])
	})
	it("copies an OpenRouter key from flat state without coercing the provider", async () => {
		const f = fixture(
			{
				actModeApiProvider: "openrouter",
				planModeApiProvider: "openrouter",
				actModeOpenRouterModelId: "or/m",
				planModeOpenRouterModelId: "or/m",
			},
			{ openRouterApiKey: "sk-or" },
		)
		await f.run()
		const connection = f.settings().connections[0]
		expect(connection).toMatchObject({ kind: "provider", providerId: "openrouter" })
		await expect(resolveConnectionConfig(connection, { secrets: f.secrets, environment: {} })).resolves.toMatchObject({
			apiKey: "sk-or",
		})
	})
	it("copies an OpenRouter profile's own key", async () => {
		const f = fixture(
			{
				apiConfigProfiles: [{ id: "or", name: "or", provider: "openrouter", modelId: "or/m" }],
				actProfileId: "or",
				askProfileId: "or",
			},
			{ "profile:or:openRouterApiKey": "sk-own" },
		)
		await f.run()
		await expect(
			resolveConnectionConfig(f.settings().connections[0], { secrets: f.secrets, environment: {} }),
		).resolves.toMatchObject({ apiKey: "sk-own" })
	})
	it("makes a keyless Cline config an account connection, and reuses a signed-in account row", async () => {
		const f = fixture({
			actModeApiProvider: "cline",
			planModeApiProvider: "cline",
			actModeClineModelId: "c/m",
			planModeClineModelId: "c/m",
		})
		await f.run()
		expect(f.settings().connections[0].auth).toEqual({ kind: "sdk-account", providerId: "cline" })
		const signedIn = fixture({ actModeApiProvider: "cline", actModeClineModelId: "c/m" })
		await migrateModelSettings({
			...signedIn.deps,
			sdkInput: { providers: { providers: { cline: { settings: { provider: "cline", model: "c/m" } } } } },
		})
		expect(signedIn.settings().models).toHaveLength(1)
		expect(signedIn.settings().roles.chat?.modelId).toBe(signedIn.rowOf("c/m").id)
	})
	it("keeps a Cline key that is actually stored", async () => {
		const f = fixture({ actModeApiProvider: "cline", actModeClineModelId: "c/m" }, { clineApiKey: "ck" })
		await f.run()
		expect(f.settings().connections[0].auth.kind).toBe("keychain")
	})
	it("creates no historical rows beside saved configurations", async () => {
		const f = fixture(
			{ ...base(), planModeOpenAiModelId: "other", actModeApiModelId: "stale" },
			{ ...keys(), openAiApiKey: "GLOBAL" },
		)
		await f.run()
		expect(f.settings().models.map((m) => m.upstreamId)).toEqual(["m1", "m2"])
		expect(JSON.stringify(f.settings())).not.toContain("Previous")
	})
	it("names a flat-only selection plainly and shares one row between modes", async () => {
		const f = fixture(
			{
				actModeApiProvider: "anthropic",
				planModeApiProvider: "anthropic",
				actModeApiModelId: "cl",
				planModeApiModelId: "cl",
				openAiHeaders: { Authorization: "leak" },
			},
			{ apiKey: "sk-ant" },
		)
		await f.run()
		const settings = f.settings()
		expect(settings.models).toHaveLength(1)
		expect(settings.models[0].name).toBe("")
		expect(settings.roles.ask.enabled).toBe(false)
		expect(settings.connections[0].headers).toEqual([])
	})
	it("gives differing flat modes their own rows and turns Ask on", async () => {
		const f = fixture(
			{
				actModeApiProvider: "anthropic",
				planModeApiProvider: "anthropic",
				actModeApiModelId: "a",
				planModeApiModelId: "b",
			},
			{ apiKey: "k" },
		)
		await f.run()
		expect(f.settings().models.map((m) => m.upstreamId)).toEqual(["a", "b"])
		expect(f.settings().roles.ask.enabled).toBe(true)
	})
	it("does not add rows for a profile whose configuration is gone unless a role uses it", async () => {
		const f = fixture({ ...base(), profiles: [{ id: "gone", configurationId: "deleted" }] }, keys())
		await f.run()
		expect(f.settings().models.map((m) => m.upstreamId)).toEqual(["m1", "m2"])
		expect(f.journal().profilePicks).toMatchObject({ gone: { modelId: "missing:deleted" } })
	})
	describe("old threads with no apiSelection", () => {
		const seeded = async () => {
			const f = fixture(
				{ ...base(), apiConfigProfiles: [...base().apiConfigProfiles, profile("dup", "m2")], askProfileId: "p2" },
				keys(),
			)
			await f.run()
			return f
		}
		it("use the first row for the recorded provider and model, in this mode only", async () => {
			const f = await seeded()
			const matched = f.settings().models.find((m) => m.upstreamId === "m2")!
			const { modelSelectionV1 } = resolveTaskApiSelection(f.store, { apiProvider: "openai", modelId: "m2" }, "act")
			expect(modelSelectionV1?.act).toEqual({ modelId: matched.id, levelId: "default" })
			expect(modelSelectionV1?.ask).toEqual(f.settings().roles.ask.pick)
		})
		it("use the current selection when nothing matches, never missing:history", async () => {
			const f = await seeded()
			const { modelSelectionV1 } = resolveTaskApiSelection(f.store, { apiProvider: "gemini", modelId: "gone" }, "act")
			expect(modelSelectionV1?.act).toEqual(f.settings().roles.chat)
			expect(JSON.stringify(modelSelectionV1)).not.toContain("missing:")
		})
		it("pass settings to threads that recorded a selection", async () => {
			const f = await seeded()
			const { modelSelectionV1 } = resolveTaskApiSelection(f.store, { apiSelection: { actProfileId: "p1" } }, "act")
			expect(modelSelectionV1?.ask).toEqual(f.settings().roles.ask.pick)
		})
	})
})

describe("M11: a bad value costs that value", () => {
	const good = profile("good", "m-good")
	const assigned = { actProfileId: "good", askProfileId: "good" }
	const issue = (f: ReturnType<typeof fixture>, field: string) => f.journal().issues?.find((i) => i.field === field)
	it("flags a blank model ID on a provider with no default, and the resolver says what to fix", async () => {
		const f = fixture({ apiConfigProfiles: [good, profile("blank", "")], ...assigned })
		await f.run()
		expect(f.journal().status).toBe("complete")
		const row = f.rowOf("model-id-needed")
		expect(row.name).toBe("blank")
		expect(issue(f, "modelId")).toMatchObject({ kind: "normalized", source: "blank", modelId: row.id })
		expect(() => resolveConfiguredPick(f.settings(), { modelId: row.id, levelId: "default" })).toThrow("no model ID")
	})
	it("uses the provider's default for a blank model ID when it has one", async () => {
		const f = fixture({ apiConfigProfiles: [good, { id: "a", name: "a", provider: "anthropic", modelId: "" }], ...assigned })
		await f.run()
		expect(f.settings().models).toHaveLength(2)
		expect(f.settings().models[1].upstreamId).not.toBe("model-id-needed")
		expect(f.settings().models[1].upstreamId.length).toBeGreaterThan(0)
	})
	it("treats a zero or invalid limit as unknown and keeps the rest", async () => {
		const f = fixture({
			apiConfigProfiles: [
				good,
				profile("zero", "m", {
					options: {
						openAiBaseUrl: "https://a.test/v1",
						actModeOpenAiModelInfo: { contextWindow: 0, maxTokens: "lots", inputPrice: -2, outputPrice: 3 },
					},
				}),
			],
			...assigned,
		})
		await f.run()
		const { overrides } = f.rowOf("m")
		expect(overrides.contextWindow).toBeUndefined()
		expect(overrides.maxOutputTokens).toBeUndefined()
		expect(overrides.inputPrice).toBeUndefined()
		expect(overrides.outputPrice).toBe(3)
		expect(issue(f, "contextWindow")).toMatchObject({ kind: "normalized", source: "zero" })
	})
	it("flags an invalid base URL, which can never reach a real host", async () => {
		const f = fixture({
			apiConfigProfiles: [good, profile("bad", "m", { options: { openAiBaseUrl: "not a url" } })],
			...assigned,
		})
		await f.run()
		const row = f.rowOf("m")
		const connection = f.settings().connections.find((c) => c.id === row.connectionId)!
		expect(connection.baseUrl).toBe("https://base-url-needed.invalid/")
		expect(new URL(connection.baseUrl!).hostname.endsWith(".invalid")).toBe(true)
		expect(issue(f, "baseUrl")).toMatchObject({ kind: "normalized", connectionId: connection.id })
		expect(JSON.stringify(f.data.modelSettingsMigration)).not.toContain("not a url")
		expect(() => resolveConfiguredPick(f.settings(), { modelId: row.id, levelId: "default" })).toThrow("base URL")
	})
	it("trims a base URL rather than flagging it", async () => {
		const f = fixture({ apiConfigProfiles: [profile("sp", "m", { options: { openAiBaseUrl: " https://a.test/v1 " } })] })
		await f.run()
		expect(f.settings().connections[0].baseUrl).toBe("https://a.test/v1")
		expect(f.journal().issues).toBeUndefined()
	})
	it("drops only the header that can't be represented, and records its position, not its name", async () => {
		const f = fixture({
			apiConfigProfiles: [
				profile("h", "m", {
					options: {
						openAiBaseUrl: "https://a.test/v1",
						openAiHeaders: {
							"X Pasted-sk-secret": "v",
							"X-Good": "ok",
							"X-Crlf": "a\r\nb",
							"x-good": "dup",
							" X-Trim ": "v\n",
						},
					},
				}),
			],
		})
		await f.run()
		const headers = f.settings().connections[0].headers
		expect(headers.map((h) => h.name)).toEqual(["X-Good", "X-Trim"])
		expect(headers[1]).toMatchObject({ value: "v" })
		expect(f.journal().issues?.map((i) => i.field)).toEqual(["header 1", "header 3", "header 4"])
		const { apiConfigProfiles: _legacyIsLeftAlone, ...written } = f.data
		expect(JSON.stringify(written)).not.toContain("sk-secret")
	})
	it("drops an option of the wrong type and records it", async () => {
		const f = fixture({
			apiConfigProfiles: [
				{ id: "b", name: "b", provider: "bedrock", modelId: "b/m", options: { awsRegion: 5, awsProfile: "work" } },
			],
		})
		await f.run()
		expect(f.settings().connections[0]).toMatchObject({ options: { awsProfile: "work" } })
		expect(issue(f, "awsRegion")).toMatchObject({ kind: "dropped" })
	})
	it("drops an entry with no provider or a bad profile and keeps going", async () => {
		const f = fixture({
			apiConfigProfiles: [good, { id: "x", name: "x" }, null],
			profiles: [{ name: "broken" }, { id: "ok", configurationId: "good" }],
			subagentsMaxConcurrent: 2.5,
			subagentProfilesEnabled: true,
			subagentAllowedModelProfileIds: "nope",
			...assigned,
		})
		await f.run()
		expect(f.settings().models).toHaveLength(1)
		expect(f.settings().subagents.maxConcurrent).toBe(3)
		expect(f.journal().issues?.map((i) => i.field)).toEqual(
			expect.arrayContaining([
				"provider",
				"apiConfigProfiles",
				"profile",
				"subagentsMaxConcurrent",
				"subagentAllowedModelProfileIds",
			]),
		)
	})
	it("records corrupt SDK files and migrates everything else", async () => {
		const dir = await mkdtemp(join(tmpdir(), "settings-sdk-input-"))
		try {
			await mkdir(join(dir, "settings"))
			await writeFile(join(dir, "settings", "providers.json"), "{ not json sk-secret")
			await writeFile(join(dir, "settings", "models.json"), "[]")
			const f = fixture({ apiConfigProfiles: [good], ...assigned })
			await migrateModelSettings({ ...f.deps, sdkInput: () => readSdkMigrationInput(dir) })
			expect(f.journal().status).toBe("complete")
			expect(f.settings().models).toHaveLength(1)
			expect(f.journal().issues?.map((i) => i.source)).toEqual(["providers.json", "models.json"])
			expect(JSON.stringify(f.data)).not.toContain("sk-secret")
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})
	it("reports a true failure without its message and stays retryable", async () => {
		const f = fixture({ apiConfigProfiles: [good], ...assigned }, { "profile:good:openAiApiKey": "sk-real" })
		const set = f.secrets.set.bind(f.secrets)
		f.secrets.set = async () => {
			throw new Error("store rejected sk-real")
		}
		const error = await f.run().catch((e: unknown) => e)
		expect(redactedMigrationCause(error)).toBe("Could not write to the connection keychain")
		expect(redactedMigrationCause(new Error("boom sk-real"))).toBe("Unexpected Error while moving model settings")
		expect(f.journal().status).toBe("prepared")
		expect(f.data.modelSettings).toBeUndefined()
		f.secrets.set = set
		expect(await f.run()).toBe("complete")
	})
})

describe("Can follow 1: the backup is an allowlist", () => {
	const sensitive = [
		"SUBKEY",
		"AUTHV",
		"APIK",
		"sess=1",
		"AKIAEXAMPLE",
		"SEKRET",
		"SESSIONTOK",
		"ACCESSTOK",
		"REFRESHTOK",
		"APIKEYV",
		"HDRV",
		"URLPASS",
		"QUERYSECRET",
	]
	const seed = {
		apiConfigProfiles: [
			{
				id: "h",
				name: "h",
				provider: "openai",
				modelId: "x",
				surprise: "SEKRET",
				options: {
					openAiBaseUrl: "https://user:URLPASS@h.test/v1?key=QUERYSECRET",
					openAiHeaders: {
						"Ocp-Apim-Subscription-Key": "SUBKEY",
						"X-Auth": "AUTHV",
						"x-api-key": "APIK",
						Cookie: "sess=1",
						"X-Plain": "shown",
					},
					notAKnownSetting: "SEKRET",
				},
			},
		],
		actProfileId: "h",
		askProfileId: "h",
		openAiHeaders: { "X-Auth": "AUTHV" },
		subagentSomethingNew: "SEKRET",
		threadDefaultSecret: "SEKRET",
		actModeOpenAiModelInfo: { contextWindow: 100, apiKey: "APIKEYV", extra: "SEKRET" },
	}
	const sdkInput = {
		providers: {
			lastUsedProvider: "bedrock",
			providers: {
				bedrock: {
					settings: {
						provider: "bedrock",
						model: "m",
						aws: { accessKey: "AKIAEXAMPLE", secretKey: "SEKRET", sessionToken: "SESSIONTOK", region: "us" },
						auth: { accessToken: "ACCESSTOK", refreshToken: "REFRESHTOK" },
						apiKey: "APIKEYV",
						headers: { "X-Custom-Auth": "HDRV" },
					},
				},
			},
		},
		models: {
			providers: {
				x: {
					provider: { apiKey: "APIKEYV", baseUrl: "https://m.test" },
					models: { m1: { contextWindow: 9, token2: "SEKRET" } },
				},
			},
		},
	}
	it("holds no credential from any source, and keeps what it lists", async () => {
		const f = fixture(seed, { "profile:h:openAiApiKey": "K" })
		await migrateModelSettings({ ...f.deps, sdkInput })
		const backup = JSON.stringify(f.data.modelSettingsBackupV1)
		for (const value of sensitive) expect(backup, value).not.toContain(value)
		expect(f.data.modelSettingsBackupV1.legacy.apiConfigProfiles[0]).toMatchObject({ id: "h", modelId: "x" })
		expect(f.data.modelSettingsBackupV1.legacy.apiConfigProfiles[0].options.openAiBaseUrl).toBe("https://h.test/v1")
		expect(f.data.modelSettingsBackupV1.legacy.apiConfigProfiles[0].options.openAiHeaders.names).toContain("X-Auth")
		expect(f.data.modelSettingsBackupV1.sdkLegacy.providers.bedrock).toEqual({ model: "m" })
		expect(f.data.modelSettingsBackupV1.secretKeys).toEqual(["profile:h:openAiApiKey"])
	})
	it("keeps every header as text, whatever it's called", async () => {
		const f = fixture(seed, { "profile:h:openAiApiKey": "K" })
		await migrateModelSettings({ ...f.deps, sdkInput })
		const connection = f.settings().connections.find((c) => c.headers.some((h) => h.name === "X-Plain"))!
		expect(connection.headers.length).toBeGreaterThan(1)
		for (const header of connection.headers) expect(header.storage, header.name).toBe("plain")
		const stored = JSON.stringify(f.data.modelSettings)
		// Credentials that aren't headers still never land in the store.
		for (const value of ["AKIAEXAMPLE", "APIKEYV", "SEKRET"]) expect(stored, value).not.toContain(value)
	})
	it("keeps the backup immutable across a failed then successful run", async () => {
		const f = fixture(seed, { "profile:h:openAiApiKey": "K" })
		await migrateModelSettings({ ...f.deps, secrets: undefined }).catch(() => {})
		const backup = structuredClone(f.data.modelSettingsBackupV1)
		f.data.threadTitlesEnabled = true
		await f.run()
		expect(f.data.modelSettingsBackupV1).toEqual(backup)
	})
})

describe("keyless OpenAI-compatible profiles", () => {
	it("a URL and no key becomes none, so a local server keeps working", async () => {
		const f = fixture({ apiConfigProfiles: [profile("local", "m")] }, { openAiApiKey: "provider-key" })
		await f.run()
		const connection = f.settings().connections[0]
		expect(connection.auth).toEqual({ kind: "none" })
		// The provider key is never picked up, and no other credential lands on the row.
		expect(connection.headers).toEqual([])
		expect(await f.secrets.get(`settings:v1:connection:${connection.id}:openAiApiKey`)).toBeUndefined()
		const config = await resolveConnectionConfig(connection, { secrets: f.secrets, environment: {} })
		expect(config.apiKey).toBe("")
	})
	it("a flat selection with a URL and no key runs keyless too", async () => {
		const f = fixture({ actModeApiProvider: "openai", actModeOpenAiModelId: "m", openAiBaseUrl: "http://localhost:8000/v1" })
		await f.run()
		expect(f.settings().connections[0].auth).toEqual({ kind: "none" })
	})
	it("a profile with its own key is unaffected", async () => {
		const f = fixture(
			{ apiConfigProfiles: [profile("own", "m")] },
			{ "profile:own:openAiApiKey": "own-key", openAiApiKey: "provider-key" },
		)
		await f.run()
		const { auth } = f.settings().connections[0]
		expect(auth.kind).toBe("keychain")
		if (auth.kind === "keychain") expect(await f.secrets.get(auth.secretRef)).toBe("own-key")
	})
	it("a compatible profile with no URL still needs a key, since nothing says it's keyless", async () => {
		const f = fixture({ apiConfigProfiles: [profile("no-url", "m", { options: {} })] })
		await f.run()
		expect(f.settings().connections[0].auth.kind).toBe("keychain")
	})
	it("a native provider missing its key still needs one", async () => {
		const f = fixture({ apiConfigProfiles: [{ id: "n", name: "n", provider: "openai-native", modelId: "gpt-5" }] })
		await f.run()
		expect(f.settings().connections[0].auth.kind).toBe("keychain")
	})
})

describe("migrated levels", () => {
	const unknownModel = (id: string, url = "https://a.test/v1") => profile(id, id, { options: { openAiBaseUrl: url } })
	const withEffort = (id: string, effort = "high") => ({ ...unknownModel(id), reasoningEffort: effort })
	it("gives a model nothing says reasons only Default, with reasoning unknown and no effort to send", async () => {
		const f = fixture({ apiConfigProfiles: [unknownModel("plain")], actProfileId: "plain" })
		await f.run()
		const row = f.rowOf("plain")
		expect(row.overrides.levels).toBeUndefined()
		expect(row.overrides.reasoning).toBeUndefined()
		expect(row.migratedValues).toBeUndefined()
		expect(f.settings().roles.chat).toEqual({ modelId: row.id, levelId: "default" })
		const resolved = resolveConfiguredPick(f.settings(), { modelId: row.id, levelId: "default" })
		expect(resolved.values.reasoning).toBe("unknown")
		expect(resolved.values.levels.map((l) => l.id)).toEqual(["default"])
		// A level it doesn't offer is refused, so nothing can send one by accident.
		expect(() => resolveConfiguredPick(f.settings(), { modelId: row.id, levelId: "low" })).toThrow()
	})
	it("takes 'none' as no saved effort", async () => {
		const f = fixture({ apiConfigProfiles: [withEffort("off", "none")] })
		await f.run()
		expect(f.rowOf("off").overrides.levels).toBeUndefined()
	})
	it("gives a model the ladder when a profile saved an effort for it", async () => {
		const f = fixture({
			apiConfigProfiles: [unknownModel("plain")],
			modelProfiles: [{ id: "x", name: "X", configurationId: "plain", reasoningEffort: "low" }],
		})
		await f.run()
		expect(f.rowOf("plain").overrides.levels?.length).toBeGreaterThan(1)
		expect(f.rowOf("plain").overrides.reasoning).toBe("yes")
	})
	it("gives a model the catalog's levels when the catalog says it reasons", async () => {
		const known = createGateway()
			.listModels("openai-native")
			.find((m) => m.capabilities?.includes("reasoning"))
		expect(known).toBeDefined()
		const f = fixture({
			apiConfigProfiles: [{ id: "a", name: "a", provider: "openai-native", modelId: known!.id }],
			actProfileId: "a",
		})
		await f.run()
		expect(f.rowOf(known!.id).overrides.levels?.length).toBeGreaterThan(1)
	})
	it("doesn't lend one model's ladder to another on the same connection", async () => {
		const f = fixture({ apiConfigProfiles: [withEffort("deep"), unknownModel("plain")] })
		await f.run()
		expect(f.settings().connections).toHaveLength(1)
		const deep = resolveConfiguredPick(f.settings(), { modelId: f.rowOf("deep").id, levelId: "high" })
		expect(deep.levelId).toBe("high")
		const plain = resolveConfiguredPick(f.settings(), { modelId: f.rowOf("plain").id, levelId: "default" })
		expect(plain.values.levels.map((l) => l.id)).toEqual(["default"])
		expect(plain.values.reasoning).toBe("unknown")
	})
	it("marks the levels and reasoning it stored, since nobody chose them", async () => {
		const f = fixture({ apiConfigProfiles: [withEffort("solo")] })
		await f.run()
		const row = f.rowOf("solo")
		expect(row.overrides).toMatchObject({ reasoning: "yes" })
		expect(row.overrides.levels?.length).toBeGreaterThan(1)
		expect(row.migratedValues).toEqual(["levels", "reasoning"])
	})
	it("leaves no marker for what moves up to the connection", async () => {
		const f = fixture({ apiConfigProfiles: [withEffort("one"), withEffort("two")] })
		await f.run()
		expect(f.settings().connections).toHaveLength(1)
		expect(f.settings().connections[0].defaults).toMatchObject({ reasoning: "yes" })
		expect(f.rowOf("one").migratedValues).toBeUndefined()
		expect(f.rowOf("two").migratedValues).toBeUndefined()
	})
})

describe("Oracle accounts", () => {
	it("a saved OCA selection becomes the sign-in account, not a copy of its expiring token", async () => {
		const f = fixture(
			{ actModeApiProvider: "oca", actModeOcaModelId: "oca/m" },
			{ ocaApiKey: "signed-in-token", ocaRefreshToken: "refresh" },
		)
		await f.run()
		const connection = f.settings().connections[0]
		expect(connection.auth).toEqual({ kind: "sdk-account", providerId: "oca" })
		expect(JSON.stringify(f.settings())).not.toContain("signed-in-token")
		expect(await f.secrets.get(`settings:v1:connection:${connection.id}:ocaApiKey`)).toBeUndefined()
	})
})

describe("journal issues", () => {
	it("are part of the journal's strict schema, and are checked by it", async () => {
		const f = fixture({ apiConfigProfiles: [profile("blank", "")] })
		await f.run()
		expect(f.journal().issues?.length).toBeGreaterThan(0)
		expect(ModelSettingsMigrationSchema.safeParse(f.journal()).success).toBe(true)
		expect(ModelSettingsMigrationSchema.safeParse({ ...f.journal(), issues: [{ kind: "odd" }] }).success).toBe(false)
	})
})
