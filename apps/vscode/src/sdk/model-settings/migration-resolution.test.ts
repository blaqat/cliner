import { createCompatibleConnection, createDefaultModelSettings, type ModelSettings } from "@shared/model-settings"
import { describe, expect, it, vi } from "vitest"
import { migrateModelSettings } from "@/core/storage/model-settings-migration"
import {
	captureThreadModelSelection,
	migrateThreadModelSelection,
	NextMessageModelSelections,
	resolveBackgroundPick,
	resolveConfiguredPick,
	resolveModelSettingsRequest,
	resolveThreadPick,
} from "../model-settings-resolver"
import { InMemoryConnectionSecretStore } from "./connection-secret-store"
import { MODEL_SETTINGS_ROLLOUT_ENABLED } from "./rollout"

function fixture(seed: Record<string, unknown> = {}) {
	const data = structuredClone(seed)
	let writes = 0
	let interrupt = Infinity
	const keys: Record<string, string> = {
		"profile:a:openAiApiKey": "own-a",
		"profile:b:openAiApiKey": "own-b",
		openAiApiKey: "provider",
	}
	const secrets = new InMemoryConnectionSecretStore()
	const write = () => {
		if (++writes === interrupt) throw new Error("interrupted")
	}
	const state = {
		keys: () => Object.keys(data),
		get: (k: string) => structuredClone(data[k]),
		update: async (k: string, v: unknown) => {
			data[k] = structuredClone(v)
			write()
		},
	}
	const set = secrets.set.bind(secrets)
	secrets.set = async (k, v) => {
		await set(k, v)
		write()
	}
	const deps = {
		state: state as never,
		secrets,
		legacySecretKeys: Object.keys(keys),
		readLegacySecret: (k: string) => keys[k],
		enabled: true,
	}
	return {
		data,
		deps,
		keys,
		secrets,
		interrupt: (n: number) => {
			interrupt = n
			writes = 0
		},
		writes: () => writes,
	}
}
const configuration = (id: string, provider = "openai") => ({
	id,
	name: "Same name",
	provider,
	modelId: "same-model",
	options: { openAiBaseUrl: "https://example.test/v1" },
})
const seed = () => ({
	apiConfigProfiles: [configuration("a"), configuration("b")],
	profiles: [{ id: "high", name: "High", configurationId: "a", reasoningEffort: "high" }],
	threadDefaultProfileId: "high",
	walkthroughGenerateProfileId: "b",
	threadTitlesEnabled: true,
})

describe("Phase 2 migration", () => {
	it("defaults off and performs zero writes, reads, or credential operations", async () => {
		expect(MODEL_SETTINGS_ROLLOUT_ENABLED).toBe(false)
		const f = fixture(seed())
		const before = structuredClone(f.data)
		expect(await migrateModelSettings({ ...f.deps, enabled: undefined })).toBe("disabled")
		expect(f.data).toEqual(before)
		expect(f.writes()).toBe(0)
		const legacy = vi.fn(() => "legacy-result")
		const settings = vi.fn(() => {
			throw new Error("new store read")
		})
		expect(
			await resolveModelSettingsRequest({
				legacy,
				settings,
				pick: () => null,
				request: {} as never,
				dependencies: {} as never,
			}),
		).toBe("legacy-result")
		expect(legacy).toHaveBeenCalledOnce()
		expect(settings).not.toHaveBeenCalled()
	})
	it("retries after every durable write using the same IDs and retains downgrade data", async () => {
		const baseline = fixture(seed())
		await migrateModelSettings(baseline.deps)
		const total = baseline.writes()
		for (let n = 1; n <= total; n++) {
			const f = fixture(seed())
			f.interrupt(n)
			await expect(migrateModelSettings(f.deps)).rejects.toThrow("interrupted")
			f.interrupt(Infinity)
			await migrateModelSettings(f.deps)
			expect(f.data.modelSettings).toEqual(baseline.data.modelSettings)
			expect(f.data.apiConfigProfiles).toEqual(seed().apiConfigProfiles)
			expect(JSON.stringify(f.data)).not.toContain("own-a")
			const before = structuredClone(f.data)
			await migrateModelSettings(f.deps)
			expect(f.data).toEqual(before)
		}
	})
	it("keeps own-key connections separate and never falls back for missing profile keys", async () => {
		const f = fixture({ apiConfigProfiles: [configuration("a"), configuration("b"), configuration("missing")] })
		await migrateModelSettings(f.deps)
		const s = f.data.modelSettings as ModelSettings
		expect(s.connections).toHaveLength(3)
		for (const [index, expected] of ["own-a", "own-b", undefined].entries()) {
			const auth = s.connections[index].auth
			expect(auth.kind).toBe("keychain")
			if (auth.kind === "keychain") expect(await f.secrets.get(auth.secretRef)).toBe(expected)
		}
	})
	it("leaves a retryable prepared journal when keychain is absent", async () => {
		const f = fixture(seed())
		await expect(migrateModelSettings({ ...f.deps, secrets: undefined })).rejects.toThrow("keychain")
		expect(f.data.modelSettings).toBeUndefined()
		expect(f.data.modelSettingsMigration).toMatchObject({ status: "prepared" })
		await migrateModelSettings(f.deps)
		expect(f.data.modelSettingsMigration).toMatchObject({ status: "complete" })
	})
	it("rejects malformed JSON shapes, accepts empty arrays, and preserves missing refs", async () => {
		for (const bad of ["[]", {}, [null]]) {
			const f = fixture({ apiConfigProfiles: bad })
			await expect(migrateModelSettings(f.deps)).rejects.toThrow("Invalid legacy")
			expect(f.data.modelSettings).toBeUndefined()
		}
		const empty = fixture({ apiConfigProfiles: [], profiles: [] })
		await migrateModelSettings(empty.deps)
		expect((empty.data.modelSettings as ModelSettings).roles.chat).toBeNull()
		const missing = fixture({ profiles: [{ id: "gone", configurationId: "deleted" }], threadDefaultProfileId: "gone" })
		await migrateModelSettings(missing.deps)
		expect((missing.data.modelSettings as ModelSettings).roles.chat?.modelId).toBe("missing:deleted")
	})
	it("preserves historical providers without applying the live UI allowlist", async () => {
		const f = fixture({ apiConfigProfiles: [configuration("a", "gemini")] })
		await migrateModelSettings(f.deps)
		expect((f.data.modelSettings as ModelSettings).connections[0]).toMatchObject({ kind: "provider", providerId: "gemini" })
	})
	it("imports downgrade additions without replacing new roles", async () => {
		const f = fixture(seed())
		await migrateModelSettings(f.deps)
		const roles = structuredClone((f.data.modelSettings as ModelSettings).roles)
		;(f.data.apiConfigProfiles as unknown[]).push(configuration("c"))
		await migrateModelSettings(f.deps)
		expect((f.data.modelSettings as ModelSettings).models).toHaveLength(3)
		expect((f.data.modelSettings as ModelSettings).roles).toEqual(roles)
	})
})

function settings() {
	const s = createDefaultModelSettings()
	const c = createCompatibleConnection("connection")
	c.auth = { kind: "none" }
	c.baseUrl = "https://example.test"
	s.connections = [c]
	s.models = ["a", "b", "c"].map((id) => ({
		id,
		upstreamId: id,
		connectionId: c.id,
		name: id,
		kind: "chat",
		overrides: {},
		providerOptions: {},
	}))
	s.roles.chat = { modelId: "a", levelId: "default" }
	return s
}
describe("Phase 2 resolution", () => {
	it("isolates captured threads, modes and next-message overrides", () => {
		const s = settings()
		const thread = captureThreadModelSelection(s)
		s.roles.chat = { modelId: "b", levelId: "default" }
		const other = captureThreadModelSelection(s)
		const next = { mode: "act" as const, pick: { modelId: "c", levelId: "default" } }
		expect(resolveThreadPick(thread, "act", next)?.modelId).toBe("c")
		expect(resolveThreadPick(thread, "plan", next)?.modelId).toBe("a")
		expect(resolveThreadPick(thread, "act")?.modelId).toBe("a")
		expect(resolveThreadPick(other, "act")?.modelId).toBe("b")
	})
	it("migrates old threads independently and retains missing stored selections", () => {
		const journal = { configurationModels: { a: "new-a" }, profilePicks: {} } as never
		expect(
			migrateThreadModelSelection({ askProfileId: "a", actProfileId: "deleted", planModeReasoningEffort: "high" }, journal),
		).toEqual({
			version: 1,
			ask: { modelId: "new-a", levelId: "high" },
			act: { modelId: "missing:deleted", levelId: "default" },
		})
	})
	it("routes titles, Generate and commits independently and skips disabled titles", () => {
		const s = settings()
		s.roles.background = {
			pick: s.roles.chat,
			titlesEnabled: true,
			overrides: { generate: { modelId: "b", levelId: "default" }, commitMessages: { modelId: "c", levelId: "default" } },
		}
		expect(["titles", "generate", "commitMessages"].map((use) => resolveBackgroundPick(s, use as never)?.modelId)).toEqual([
			"a",
			"b",
			"c",
		])
		s.roles.background.titlesEnabled = false
		expect(resolveBackgroundPick(s, "titles")).toBeNull()
	})
	it("refuses unavailable levels and missing picks with a repair destination", () => {
		const s = settings()
		expect(() => resolveConfiguredPick(s, { modelId: "a", levelId: "high" })).toThrow("Saved level 'high' is not offered")
		expect(() => resolveConfiguredPick(s, null)).toThrow("Settings > Models")
		expect(() => resolveConfiguredPick(s, { modelId: "gone", levelId: "default" })).toThrow("unavailable")
		expect(() => resolveBackgroundPick(s, "generate")).toThrow("Background text")
	})
})

it("serializes two independently loaded windows against the same isolated store", async () => {
	const { mkdtemp, rm } = await import("node:fs/promises")
	const { tmpdir } = await import("node:os")
	const { join } = await import("node:path")
	const { createStorageContext } = await import("@shared/storage/storage-context")
	const dir = await mkdtemp(join(tmpdir(), "settings-phase2-windows-"))
	try {
		const first = createStorageContext({ clineDir: dir })
		await first.globalState.setBatch(seed())
		const second = createStorageContext({ clineDir: dir })
		const secrets = new InMemoryConnectionSecretStore()
		const migrate = (storage: typeof first) =>
			storage.globalStateBackingStore.withLock(async () => {
				storage.globalStateBackingStore.reload()
				return migrateModelSettings({
					state: storage.globalState,
					secrets,
					legacySecretKeys: [],
					readLegacySecret: () => undefined,
					enabled: true,
				})
			})
		await Promise.all([migrate(first), migrate(second)])
		first.globalStateBackingStore.reload()
		expect(first.globalState.get<ModelSettings>("modelSettings")?.models).toHaveLength(2)
		expect(first.globalState.get("modelSettingsMigration")).toEqual(second.globalState.get("modelSettingsMigration"))
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})

it("keeps the CLI shared-store fixture unchanged and readable after migration and resolution", async () => {
	const { mkdtemp, mkdir, readFile, writeFile, rm } = await import("node:fs/promises")
	const { tmpdir } = await import("node:os")
	const { join } = await import("node:path")
	const { execFileSync } = await import("node:child_process")
	const dir = await mkdtemp(join(tmpdir(), "settings-phase2-cli-"))
	try {
		await mkdir(join(dir, "settings"))
		const sdk = (seed: boolean) =>
			JSON.parse(
				execFileSync(
					"bun",
					[
						"--eval",
						`import {ProviderSettingsManager} from "@cline/core"; const dir = process.argv[1]; const manager = new ProviderSettingsManager({filePath: dir + "/settings/providers.json", dataDir: dir}); if (process.argv[2] === "seed") manager.saveProviderSettings({provider: "anthropic", apiKey: "fake-cli-only", model: "claude-test"}); console.log(JSON.stringify(manager.getProviderSettings("anthropic")));`,
						dir,
						seed ? "seed" : "read",
					],
					{ encoding: "utf8", env: { ...process.env, CLINE_DATA_DIR: dir, CLINE_DIR: dir } },
				),
			)
		expect(sdk(true)).toMatchObject({ apiKey: "fake-cli-only", model: "claude-test" })
		await writeFile(join(dir, "settings", "global-settings.json"), JSON.stringify({ webSearchEnabled: true }))
		await writeFile(join(dir, "settings", "models.json"), JSON.stringify({ overrides: {} }))
		const paths = ["providers.json", "global-settings.json", "models.json"].map((file) => join(dir, "settings", file))
		const before = await Promise.all(paths.map((file) => readFile(file, "utf8")))
		const f = fixture(seed())
		await migrateModelSettings(f.deps)
		const s = f.data.modelSettings as ModelSettings
		const result = await resolveModelSettingsRequest({
			enabled: true,
			legacy: () => {
				throw new Error("legacy request")
			},
			settings: () => s,
			pick: () => s.roles.chat,
			request: { request: { providerId: "unused", modelId: "unused", messages: [] }, context: {} as never },
			dependencies: { secrets: f.secrets, environment: {} },
		})
		expect(result.config.apiKey).toBe("own-a")
		expect(sdk(false)).toMatchObject({ apiKey: "fake-cli-only", model: "claude-test" })
		expect(JSON.parse(await readFile(paths[1], "utf8"))).toMatchObject({ webSearchEnabled: true })
		expect(await Promise.all(paths.map((file) => readFile(file, "utf8")))).toEqual(before)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
}, 60000)

it("consumes next-message picks only after successful admission and preserves other threads and modes", async () => {
	const next = new NextMessageModelSelections()
	const thread = captureThreadModelSelection(settings())
	next.set("first", "act", { modelId: "b", levelId: "default" })
	next.set("first", "plan", { modelId: "c", levelId: "default" })
	await expect(
		next.admit("first", "act", thread, async () => {
			throw new Error("missing key")
		}),
	).rejects.toThrow("missing key")
	expect(await next.admit("other", "act", thread, async (p) => p?.modelId)).toBe("a")
	expect(await next.admit("first", "act", thread, async (p) => p?.modelId)).toBe("b")
	expect(await next.admit("first", "act", thread, async (p) => p?.modelId)).toBe("a")
	expect(await next.admit("first", "plan", thread, async (p) => p?.modelId)).toBe("c")
})

describe("Phase 2 follow-up migration", () => {
	it("groups models by actual credentials and preserves IDs on retry", async () => {
		const f = fixture({ apiConfigProfiles: [configuration("a"), { ...configuration("b"), modelId: "second" }] })
		f.keys["profile:b:openAiApiKey"] = "own-a"
		await migrateModelSettings(f.deps)
		const s = f.data.modelSettings as ModelSettings
		expect(s.connections).toHaveLength(1)
		expect(s.models).toHaveLength(2)
		expect(s.models[0].connectionId).toBe(s.models[1].connectionId)
		const before = structuredClone(f.data)
		await migrateModelSettings(f.deps)
		expect(f.data).toEqual(before)
	})
	it("imports secret-only edits without replacing roles or original credentials", async () => {
		const f = fixture(seed())
		await migrateModelSettings(f.deps)
		const original = structuredClone(f.data.modelSettings) as ModelSettings
		f.keys["profile:a:openAiApiKey"] = "replacement"
		await migrateModelSettings(f.deps)
		const updated = f.data.modelSettings as ModelSettings
		expect(updated.models).toHaveLength(original.models.length + 1)
		expect(updated.roles).toEqual(original.roles)
		const auth = original.connections[0].auth
		if (auth.kind === "keychain") expect(await f.secrets.get(auth.secretRef)).toBe("own-a")
		const before = structuredClone(f.data)
		await migrateModelSettings(f.deps)
		expect(f.data).toEqual(before)
		expect(JSON.stringify(f.data)).not.toContain("replacement")
	})
	it("reconciles models.json without promoting differing model limits", async () => {
		const f = fixture({ apiConfigProfiles: [configuration("a"), { ...configuration("b"), modelId: "second" }] })
		f.keys["profile:b:openAiApiKey"] = "own-a"
		const sdkInput = {
			models: {
				version: 1,
				providers: {
					"openai-compatible": {
						models: {
							"same-model": { contextWindow: 32000, maxTokens: 2000, inputPrice: 1, supportsVision: true },
							second: { contextWindow: 64000, maxTokens: 4000, inputPrice: 2 },
						},
					},
				},
			},
		}
		const snapshot = JSON.stringify(sdkInput)
		await migrateModelSettings({ ...f.deps, sdkInput })
		const s = f.data.modelSettings as ModelSettings
		expect(s.connections).toHaveLength(1)
		expect(s.connections[0].defaults.contextWindow).toBeUndefined()
		expect(s.models.map((m) => m.overrides.contextWindow)).toEqual([32000, 64000])
		expect(s.models[0].overrides.images).toBe("yes")
		expect(JSON.stringify(sdkInput)).toBe(snapshot)
	})
})

it("keeps transport differences separate and retries grouped writes deterministically", async () => {
	const input = { apiConfigProfiles: [configuration("a"), { ...configuration("b"), modelId: "second" }] }
	const baseline = fixture(input)
	baseline.keys["profile:b:openAiApiKey"] = "own-a"
	await migrateModelSettings(baseline.deps)
	for (let n = 1; n <= baseline.writes(); n++) {
		const f = fixture(input)
		f.keys["profile:b:openAiApiKey"] = "own-a"
		f.interrupt(n)
		await expect(migrateModelSettings(f.deps)).rejects.toThrow()
		f.interrupt(Infinity)
		await migrateModelSettings(f.deps)
		expect(f.data.modelSettings).toEqual(baseline.data.modelSettings)
	}
	for (const options of [
		{ openAiBaseUrl: "https://other.test/v1" },
		{ azureApiVersion: "test-version" },
		{ openAiHeaders: { "X-Test": "different" } },
	]) {
		const f = fixture({
			apiConfigProfiles: [
				configuration("a"),
				{ ...configuration("b"), options: { ...configuration("b").options, ...options } },
			],
		})
		f.keys["profile:b:openAiApiKey"] = "own-a"
		await migrateModelSettings(f.deps)
		expect((f.data.modelSettings as ModelSettings).connections).toHaveLength(2)
	}
})

it("keeps a next-message pick armed when admission is cancelled", async () => {
	const next = new NextMessageModelSelections()
	const thread = captureThreadModelSelection(settings())
	next.set("thread", "act", { modelId: "b", levelId: "default" })
	const cancel = new AbortController()
	await expect(
		next.admit(
			"thread",
			"act",
			thread,
			async () => {
				cancel.abort()
				return "ignored"
			},
			cancel.signal,
		),
	).rejects.toThrow()
	expect(await next.admit("thread", "act", thread, async (p) => p?.modelId)).toBe("b")
	expect(await next.admit("other", "act", thread, async (p) => p?.modelId)).toBe("a")
})

it("imports changed transport and locked headers once while retaining immutable historical mappings", async () => {
	const a = {
		...configuration("a"),
		options: { ...configuration("a").options, openAiHeaders: { Authorization: "header-one" } },
	}
	const f = fixture({ apiConfigProfiles: [a] })
	await migrateModelSettings(f.deps)
	const before = structuredClone(f.data.modelSettingsMigration)
	f.data.apiConfigProfiles = [{ ...a, options: { ...a.options, openAiHeaders: { Authorization: "header-two" } } }]
	await migrateModelSettings(f.deps)
	expect((f.data.modelSettings as ModelSettings).models).toHaveLength(2)
	expect((f.data.modelSettingsMigration as { configurationModels: unknown }).configurationModels).toEqual(
		(before as { configurationModels: unknown }).configurationModels,
	)
	const snapshot = structuredClone(f.data)
	await migrateModelSettings(f.deps)
	expect(f.data).toEqual(snapshot)
	f.data.apiConfigProfiles = [{ ...a, options: { ...a.options, openAiBaseUrl: "https://changed.test/v1" } }]
	await migrateModelSettings(f.deps)
	expect((f.data.modelSettings as ModelSettings).models).toHaveLength(3)
	expect(JSON.stringify([f.data.modelSettings, f.data.modelSettingsBackupV1, f.data.modelSettingsMigration])).not.toContain(
		"header-one",
	)
	expect(JSON.stringify([f.data.modelSettings, f.data.modelSettingsBackupV1, f.data.modelSettingsMigration])).not.toContain(
		"header-two",
	)
})

it("preserves every compatible form override and nested SDK metadata through migration and request assembly", async () => {
	const { readFile } = await import("node:fs/promises")
	const { configuredProviderConfig } = await import("./runtime-config")
	const form = await readFile("webview-ui/src/components/settings/providers/OpenAICompatible.tsx", "utf8")
	const mappedConnectionFields = new Set([
		"baseUrl",
		"headers",
		"reasoning",
		"openAiCompatibleApiType",
		"azureApiVersion",
		"azureIdentity",
		"planModeOpenAiModelId",
		"actModeOpenAiModelId",
	])
	for (const match of form.matchAll(
		/handleFieldChange\(\s*"([^"]+)"|write\(\{\s*(\w+)[: ,]|handleModeFieldChange\(\{\s*plan: "([^"]+)", act: "([^"]+)"/g,
	))
		for (const field of match.slice(1).filter(Boolean)) expect(mappedConnectionFields.has(field), field).toBe(true)
	// A new editable metadata control must be represented in this fixture.
	const editable = [...form.matchAll(/update(?:Numeric)?ModelOverride\("([^"]+)"/g)].map((m) => m[1])
	const info = {
		name: "Custom",
		contextWindow: 96000,
		maxTokens: 1234,
		maxInputTokens: 90000,
		supportsVision: true,
		supportsAttachments: true,
		supportsReasoning: true,
		capabilities: ["tools", "streaming", "prompt-cache"],
		inputPrice: 2,
		outputPrice: 3,
		cacheReadsPrice: 0.2,
		cacheWritesPrice: 0.4,
		temperature: 0.7,
		apiFormat: "default",
		pricing: { input: 99, output: 99 },
		reasoningOptions: [{ type: "effort", values: ["low", "high"] }],
		thinkingConfig: { maxBudget: 8192, outputPrice: 4 },
		modalities: { input: ["text", "image"], output: ["text"] },
		operation: "language",
		operationModes: ["streaming"],
		metadata: { custom: { nested: ["kept", false, 0] }, apiProtocol: "openai-chat" },
		description: "User model",
	}
	for (const field of editable) expect(Object.hasOwn(info, field), field).toBe(true)
	const overrideType = await readFile("src/shared/proto-conversions/models/modelOverrides.ts", "utf8")
	for (const [, field] of overrideType
		.split("export interface ProviderModelOverrides {")[1]
		.split("}")[0]
		.matchAll(/(\w+)\?:/g))
		expect(Object.hasOwn(info, field), field).toBe(true)
	const f = fixture({
		apiConfigProfiles: [
			{
				...configuration("a"),
				options: {
					...configuration("a").options,
					openAiHeaders: { "X-Custom": "kept" },
					azureApiVersion: "test-version",
				},
				reasoningEffort: "high",
			},
		],
	})
	const sdkInput = { models: { version: 1, providers: { "openai-compatible": { models: { "same-model": info } } } } }
	const before = structuredClone(sdkInput)
	await migrateModelSettings({ ...f.deps, sdkInput })
	expect(sdkInput).toEqual(before)
	const s = f.data.modelSettings as ModelSettings
	const row = s.models[0]
	expect(row.legacyMetadata).toMatchObject({ source: "legacy", sdk: info })
	const config = await configuredProviderConfig(
		s,
		{ modelId: row.id, levelId: "high" },
		{ secrets: f.secrets, environment: {} },
	)
	expect(config).toMatchObject({
		baseUrl: "https://example.test/v1",
		apiKey: "own-a",
		headers: { "X-Custom": "kept" },
		temperature: 0.7,
		maxOutputTokens: 1234,
		maxInputTokens: 90000,
		azure: { apiVersion: "test-version" },
	})
	const model = config.knownModels!["same-model"]
	expect(model).toMatchObject({
		name: "Custom",
		contextWindow: 96000,
		maxTokens: 1234,
		maxInputTokens: 90000,
		pricing: { input: 2, output: 3, cacheRead: 0.2, cacheWrite: 0.4 },
		reasoningOptions: info.reasoningOptions,
		thinkingConfig: info.thinkingConfig,
		modalities: info.modalities,
		operation: "language",
		operationModes: ["streaming"],
		metadata: info.metadata,
		description: "User model",
		temperature: 0.7,
		apiFormat: "default",
	})
	expect(model.capabilities).toEqual(
		expect.arrayContaining(["images", "files", "tools", "reasoning", "streaming", "prompt-cache"]),
	)
	expect(resolveConfiguredPick(s, { modelId: row.id, levelId: "low" }).values.levels.map((l) => l.id)).toEqual([
		"default",
		"low",
		"high",
	])
	const { prepareModelRequest } = await import("./request-adapter")
	const transport = vi.fn(async (_url: unknown, _init?: RequestInit) => new Response("ok"))
	const resolved = resolveConfiguredPick(s, { modelId: row.id, levelId: "high" })
	const prepared = await prepareModelRequest(
		{
			...resolved,
			request: { providerId: "openai-compatible", modelId: row.upstreamId, messages: [] },
			context: { provider: { id: "openai-compatible" }, model, config: { providerId: "openai-compatible" } } as never,
			requestTimeoutMs: null,
			fetch: transport as unknown as typeof fetch,
		},
		{ secrets: f.secrets, environment: {} },
	)
	await prepared.config.fetch!("https://example.test/v1/chat/completions", {
		body: JSON.stringify({ model: row.upstreamId, messages: [{ role: "system", content: "System" }] }),
	})
	expect(JSON.parse(String(transport.mock.calls[0][1]?.body))).toMatchObject({
		temperature: 0.7,
		max_tokens: 1234,
		reasoning_effort: "high",
	})
})

for (const variant of [
	"addition",
	"model",
	"limits",
	"url",
	"format",
	"azure",
	"plain-header",
	"locked-header",
	"key",
	"sdk-metadata",
	"removal",
	"roles-only",
] as const) {
	it(`retries each durable downgrade-import write: ${variant}`, async () => {
		const setup = async () => {
			const f = fixture(seed())
			const sdkInput = {
				models: { version: 1, providers: { "openai-compatible": { models: {} as Record<string, unknown> } } },
			}
			await migrateModelSettings({ ...f.deps, sdkInput })
			const original = structuredClone(f.data.modelSettings) as ModelSettings
			const backup = structuredClone(f.data.modelSettingsBackupV1)
			const journal = structuredClone(f.data.modelSettingsMigration)
			const configs = f.data.apiConfigProfiles as Array<ReturnType<typeof configuration>>
			switch (variant) {
				case "addition":
					configs.push(configuration("c"))
					break
				case "model":
					configs[0].modelId = "new-model"
					break
				case "limits":
					Object.assign(configs[0].options, { actModeOpenAiModelInfo: { contextWindow: 64000, maxTokens: 4321 } })
					break
				case "url":
					configs[0].options.openAiBaseUrl = "https://new.test/v1"
					break
				case "format":
					Object.assign(configs[0].options, { openAiCompatibleApiType: "responses" })
					break
				case "azure":
					Object.assign(configs[0].options, { azureApiVersion: "new-version" })
					break
				case "plain-header":
					Object.assign(configs[0].options, { openAiHeaders: { "X-Custom": "new" } })
					break
				case "locked-header":
					Object.assign(configs[0].options, { openAiHeaders: { Authorization: "private-new-header" } })
					break
				case "key":
					f.keys["profile:a:openAiApiKey"] = "private-new-key"
					break
				case "sdk-metadata":
					sdkInput.models.providers["openai-compatible"].models["same-model"] = {
						pricing: { input: 7 },
						metadata: { custom: true },
					}
					break
				case "removal":
					configs.splice(0, 1)
					break
				case "roles-only":
					f.data.threadDefaultProfileId = "b"
					break
			}
			f.interrupt(Infinity)
			return { f, original, backup, journal, sdkInput }
		}
		const baseline = await setup()
		await migrateModelSettings({ ...baseline.f.deps, sdkInput: baseline.sdkInput })
		const writes = baseline.f.writes()
		for (let n = 1; n <= writes; n++) {
			const { f, original, backup, journal, sdkInput } = await setup()
			f.interrupt(n)
			await expect(migrateModelSettings({ ...f.deps, sdkInput })).rejects.toThrow("interrupted")
			f.interrupt(Infinity)
			await migrateModelSettings({ ...f.deps, sdkInput })
			expect(f.data.modelSettings).toEqual(baseline.f.data.modelSettings)
			expect(f.data.modelSettingsBackupV1).toEqual(backup)
			const updated = f.data.modelSettings as ModelSettings
			expect(updated.roles).toEqual(original.roles)
			for (const row of original.models) expect(updated.models).toContainEqual(row)
			expect(f.data.modelSettingsMigration).toMatchObject({
				status: "complete",
				configurationModels: (journal as { configurationModels: unknown }).configurationModels,
			})
			for (const connection of original.connections)
				if (connection.auth.kind === "keychain")
					expect(await f.secrets.get(connection.auth.secretRef)).toBe(
						connection.id.includes(original.models[0].id) ? "own-a" : "own-b",
					)
			const before = structuredClone(f.data)
			await migrateModelSettings({ ...f.deps, sdkInput })
			expect(f.data).toEqual(before)
			expect(
				JSON.stringify([f.data.modelSettings, f.data.modelSettingsMigration, f.data.modelSettingsBackupV1]),
			).not.toContain("private-new")
		}
	})
}

it("admits SAP client credentials without a fictitious API key and preserves SDK-generated authorization", async () => {
	const { configuredProviderConfig } = await import("./runtime-config")
	const f = fixture({
		apiConfigProfiles: [
			{
				...configuration("a", "sapaicore"),
				options: {
					sapAiCoreBaseUrl: "https://sap.test",
					sapAiCoreTokenUrl: "https://token.test",
					sapAiResourceGroup: "group",
				},
			},
		],
	})
	f.keys["profile:a:sapAiCoreClientId"] = "fake-client"
	f.keys["profile:a:sapAiCoreClientSecret"] = "fake-secret"
	f.deps.legacySecretKeys.push("profile:a:sapAiCoreClientId", "profile:a:sapAiCoreClientSecret")
	await migrateModelSettings(f.deps)
	const s = f.data.modelSettings as ModelSettings
	expect(s.connections[0].auth).toEqual({ kind: "none" })
	const config = await configuredProviderConfig(
		s,
		{ modelId: s.models[0].id, levelId: "default" },
		{ secrets: f.secrets, environment: {} },
	)
	expect(config.settingsProviderOptions).toMatchObject({
		clientId: "fake-client",
		clientSecret: "fake-secret",
		tokenUrl: "https://token.test",
		resourceGroup: "group",
	})
	const { prepareModelRequest } = await import("./request-adapter")
	const transport = vi.fn(async (_url: unknown, _init?: RequestInit) => new Response("ok"))
	const prepared = await prepareModelRequest(
		{
			...resolveConfiguredPick(s, { modelId: s.models[0].id, levelId: "default" }),
			requestTimeoutMs: null,
			request: { providerId: "sapaicore", modelId: "same-model", messages: [] },
			context: { provider: { id: "sapaicore" }, model: { id: "same-model" }, config: { providerId: "sapaicore" } } as never,
			fetch: transport as unknown as typeof fetch,
		},
		{ secrets: f.secrets, environment: {} },
	)
	await prepared.config.fetch!("https://token.test", { headers: { Authorization: "Basic fake-token-exchange" } })
	expect(new Headers(transport.mock.calls[0][1]?.headers).get("authorization")).toBe("Basic fake-token-exchange")
	expect(JSON.stringify(s)).not.toContain("fake-secret")
})

it("uses nested prices, honors explicit false capabilities and preserves explicit legacy defaults", async () => {
	const f = fixture({
		apiConfigProfiles: [
			{
				...configuration("a"),
				options: {
					...configuration("a").options,
					actModeOpenAiModelInfo: { contextWindow: 128000, inputPrice: 0, maxTokens: -1 },
				},
			},
		],
	})
	await migrateModelSettings({
		...f.deps,
		sdkInput: {
			models: {
				version: 1,
				providers: {
					"openai-compatible": {
						models: {
							"same-model": {
								contextWindow: 32000,
								pricing: { input: 8, output: 9, cacheRead: 1, cacheWrite: 2 },
								capabilities: ["images", "reasoning", "files", "tools", "streaming"],
								supportsVision: false,
								supportsReasoning: false,
								supportsAttachments: false,
								supportsTools: false,
								supportsStreaming: false,
							},
						},
					},
				},
			},
		},
	})
	const s = f.data.modelSettings as ModelSettings
	const resolved = resolveConfiguredPick(s, { modelId: s.models[0].id, levelId: "default" })
	expect(resolved.values).toMatchObject({
		contextWindow: 128000,
		maxOutputTokens: null,
		inputPrice: 0,
		outputPrice: 9,
		cacheReadPrice: 1,
		cacheWritePrice: 2,
		images: "no",
		reasoning: "no",
		files: "no",
		tools: "no",
		streaming: "no",
	})
	expect(resolved.model.legacyMetadata?.source).toBe("legacy")
})
