import {
	BUILTIN_MODEL_VALUES,
	ConnectionSchema,
	createCompatibleConnection,
	createDefaultModelSettings,
	ModelSettingsSchema,
	ModelValuesSchema,
	resolveModelValues,
} from "@shared/model-settings"
import { describe, expect, it, vi } from "vitest"
import { InMemoryConnectionSecretStore, VSCodeConnectionSecretStore } from "./connection-secret-store"
import { prepareModelRequest, redactModelRequest, resolveConnectionConfig } from "./request-adapter"
import { ModelSettingsStore } from "./store"

describe("model settings contract", () => {
	it("has independent defaults without assigning roles", () => {
		const a = createDefaultModelSettings()
		expect(ModelSettingsSchema.parse(a)).toEqual(a)
		a.subagents.maxConcurrent = 0
		expect(ModelSettingsSchema.parse(a).subagents.maxConcurrent).toBe(0)
		expect(createDefaultModelSettings().subagents.maxConcurrent).toBe(3)
		expect(a.roles).toMatchObject({
			chat: null,
			ask: { enabled: false, pick: null },
			background: { pick: null, titlesEnabled: false },
		})
	})
	it("preserves missing, null, false, no and whole-value inheritance with provenance", () => {
		expect(ModelValuesSchema.partial().parse({ temperature: null, free: false, images: "no" })).toEqual({
			temperature: null,
			free: false,
			images: "no",
		})
		const result = resolveModelValues(
			{ temperature: null, free: false, images: "no", extraBody: {} },
			{ temperature: 1, contextWindow: 2000 },
			{ temperature: 2, free: true, contextWindow: 1000, extraBody: { seed: 1 } },
		)
		expect(result.temperature).toEqual({ value: null, source: "model" })
		expect(result.free.value).toBe(false)
		expect(result.images.value).toBe("no")
		expect(result.contextWindow).toEqual({ value: 2000, source: "metadata" })
		expect(result.extraBody.value).toEqual({})
		expect(resolveModelValues({}, undefined, { temperature: 2 }).temperature).toEqual({ value: 2, source: "connection" })
	})
	it("rejects malformed levels, headers, fields and dangling references", () => {
		const c = createCompatibleConnection("a")
		c.headers = [
			{ id: "1", name: "X-Key", storage: "plain", value: "a" },
			{ id: "2", name: "x-key", storage: "plain", value: "b" },
		]
		expect(ConnectionSchema.safeParse(c).success).toBe(false)
		expect(
			ConnectionSchema.safeParse({
				...createCompatibleConnection("a"),
				kind: "provider",
				providerId: "anthropic",
				options: { apiKey: "leak" },
				secretRefs: {},
			}).success,
		).toBe(false)
		expect(
			ModelValuesSchema.partial().safeParse({ levels: [...BUILTIN_MODEL_VALUES.levels, ...BUILTIN_MODEL_VALUES.levels] })
				.success,
		).toBe(false)
		const s = createDefaultModelSettings()
		s.roles.chat = { modelId: "missing", levelId: "bad" }
		expect(ModelSettingsSchema.safeParse(s).success).toBe(false)
		for (const value of [0, -1, 1.1, Infinity])
			expect(ModelValuesSchema.partial().safeParse({ contextWindow: value }).success).toBe(false)
	})
	it("keeps old state unchanged on reads and only writes modelSettings", () => {
		const state: Record<string, unknown> = {
			actModeApiProvider: "anthropic",
			actModeApiModelId: "old",
			apiConfigProfiles: [{ id: "legacy" }],
		}
		const before = structuredClone(state)
		const set = vi.fn((key: string, value: unknown) => {
			state[key] = value
		})
		const store = new ModelSettingsStore({ getGlobalStateKey: (key: string) => state[key], setGlobalState: set } as never)
		store.get()
		expect(set).not.toHaveBeenCalled()
		expect(state).toEqual(before)
		store.set(createDefaultModelSettings())
		expect(set).toHaveBeenCalledTimes(1)
		delete state.modelSettings
		expect(state).toEqual(before)
	})
})
describe("connection credentials and request isolation", () => {
	it("uses an injected SecretStorage fake and namespace", async () => {
		const values = new Map<string, string>()
		const adapter = new VSCodeConnectionSecretStore({
			get: async (k) => values.get(k),
			store: async (k, v) => {
				values.set(k, v)
			},
			delete: async (k) => {
				values.delete(k)
			},
		})
		await adapter.set("settings:v1:connection:a:apiKey", "secret")
		expect(await adapter.get("settings:v1:connection:a:apiKey")).toBe("secret")
		await adapter.delete("settings:v1:connection:a:apiKey")
		expect(values.size).toBe(0)
		await expect(adapter.set("legacyKey", "bad")).rejects.toThrow()
	})
	it("does not borrow credentials for missing, empty, env or none auth", async () => {
		const secrets = new InMemoryConnectionSecretStore()
		const sdkAccount = vi.fn()
		const deps = { secrets, environment: { OPENAI_API_KEY: "ambient", CUSTOM: "env-key" }, sdkAccount }
		const c = createCompatibleConnection("a")
		await expect(resolveConnectionConfig(c, deps)).rejects.toThrow("missing")
		await secrets.set(c.auth.kind === "keychain" ? c.auth.secretRef : "", " ")
		await expect(resolveConnectionConfig(c, deps)).rejects.toThrow("missing")
		expect(await resolveConnectionConfig({ ...c, auth: { kind: "none" } }, deps)).toMatchObject({ apiKey: "", apiKeyEnv: [] })
		expect(await resolveConnectionConfig({ ...c, auth: { kind: "environment", variable: "CUSTOM" } }, deps)).toMatchObject({
			apiKey: "env-key",
			apiKeyEnv: [],
		})
		await expect(resolveConnectionConfig({ ...c, auth: { kind: "environment", variable: "EMPTY" } }, deps)).rejects.toThrow(
			"empty",
		)
		expect(sdkAccount).not.toHaveBeenCalled()
	})
	it("keeps same upstream IDs at distinct URLs and uses final assembly", async () => {
		const fetch = vi.fn(async () => new Response("{}")) as unknown as typeof globalThis.fetch
		const deps = { secrets: new InMemoryConnectionSecretStore(), environment: {} }
		for (const id of ["a", "b"]) {
			const connection = {
				...createCompatibleConnection(id),
				baseUrl: `https://${id}.example/v1`,
				auth: { kind: "none" as const },
			}
			const model = {
				id: `row-${id}`,
				connectionId: id,
				upstreamId: "same",
				name: "",
				kind: "chat" as const,
				overrides: {},
				providerOptions: {},
			}
			const prepared = await prepareModelRequest(
				{
					connection,
					model,
					values: BUILTIN_MODEL_VALUES,
					levelId: "default",
					request: { providerId: "unused", modelId: "unused", messages: [] },
					context: {} as never,
					requestTimeoutMs: null,
					fetch,
				},
				deps,
			)
			expect(prepared.config.baseUrl).toBe(`https://${id}.example/v1`)
			expect(prepared.modelId).toBe(`row-${id}`)
			await prepared.config.fetch!(prepared.config.baseUrl!, {
				headers: { Authorization: "Bearer ambient" },
				body: JSON.stringify({ model: "same", messages: [], reasoning_effort: "high" }),
			})
		}
		expect(fetch).toHaveBeenCalledTimes(2)
		const init = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1]
		expect(new Headers(init.headers).has("authorization")).toBe(false)
		expect(JSON.parse(init.body).reasoning_effort).toBeUndefined()
	})
	it("redacts keys, locked headers, bearer tokens and provider credentials", () => {
		const redacted = JSON.stringify(
			redactModelRequest({
				apiKey: "sentinel",
				headers: { Authorization: "sentinel" },
				options: { awsSecretAccessKey: "sentinel" },
				maxOutputTokens: 100,
			}),
		)
		expect(redacted).not.toContain("sentinel")
		expect(redacted).toContain("100")
	})
})

it("leaves isolated SDK store files byte-for-byte unchanged", async () => {
	const { mkdtemp, writeFile, readFile, rm } = await import("node:fs/promises")
	const { tmpdir } = await import("node:os")
	const { join } = await import("node:path")
	const dir = await mkdtemp(join(tmpdir(), "settings-phase1-"))
	try {
		const files = {
			"providers.json": JSON.stringify({
				lastUsedProvider: "anthropic",
				providers: { anthropic: { apiKey: "fake-cli-key" } },
			}),
			"global-settings.json": JSON.stringify({ webSearchEnabled: true }),
			"models.json": JSON.stringify({ overrides: { old: { contextWindow: 1000 } } }),
		}
		for (const [file, body] of Object.entries(files)) await writeFile(join(dir, file), body)
		const deps = { secrets: new InMemoryConnectionSecretStore(), environment: {} }
		for (const id of ["first", "second"])
			await resolveConnectionConfig(
				{ ...createCompatibleConnection(id), baseUrl: `https://${id}.example/v1`, auth: { kind: "none" } },
				deps,
			)
		for (const [file, body] of Object.entries(files)) expect(await readFile(join(dir, file), "utf8")).toBe(body)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})
it("refreshes an explicit SDK account on each resolution", async () => {
	let token = "first"
	const deps = {
		secrets: new InMemoryConnectionSecretStore(),
		environment: {},
		sdkAccount: vi.fn(async () => ({ providerId: "anthropic", apiKey: token })),
	}
	const connection = {
		...createCompatibleConnection("account"),
		auth: { kind: "sdk-account" as const, providerId: "anthropic" },
	}
	expect((await resolveConnectionConfig(connection, deps)).apiKey).toBe("first")
	token = "refreshed"
	expect((await resolveConnectionConfig(connection, deps)).apiKey).toBe("refreshed")
})
