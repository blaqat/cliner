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
