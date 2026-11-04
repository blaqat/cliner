import { createCompatibleConnection, createDefaultModelSettings } from "@shared/model-settings"
import { describe, expect, it, vi } from "vitest"
import { cancelModelSettingsDiagnostics, modelSettingsDiagnostic } from "@/core/controller/models/modelSettingsDiagnostics"
import { InMemoryConnectionSecretStore } from "./connection-secret-store"

const transport = vi.hoisted(() => vi.fn())
vi.mock("@/shared/net", () => ({ fetch: transport }))
vi.mock("@/shared/services/Logger", () => ({ Logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock("@/sdk/provider-migration", () => ({
	getProviderSettingsManager: () => {
		throw new Error("SDK account not requested")
	},
}))

function fixture() {
	const settings = createDefaultModelSettings()
	const connection = createCompatibleConnection("c")
	connection.baseUrl = "https://example.invalid/v1"
	connection.auth = { kind: "none" }
	settings.connections.push(connection)
	settings.models.push({
		id: "m",
		connectionId: "c",
		upstreamId: "test",
		name: "Test",
		kind: "chat",
		overrides: { extraBody: { custom: "value" } },
		providerOptions: {},
	})
	const state = {
		connectionSecrets: new InMemoryConnectionSecretStore(),
		getRemoteConfigSettings: () => ({}),
		getGlobalStateKey: () => settings,
	}
	const controller = { stateManager: state }
	return { controller, settings, state }
}
describe("configured connection diagnostics", () => {
	it("hides known embeddings and preserves unknown IDs with classification", async () => {
		transport.mockResolvedValueOnce(
			Response.json({
				data: [
					{ id: "text-embedding-3-small" },
					{ id: "unknown" },
					{ id: "chat", operation: "language" },
					{ id: "image", modalities: { output: ["image"] } },
				],
			}),
		)
		const f = fixture()
		const result = await modelSettingsDiagnostic(
			f.controller as never,
			"discoverConnectionModels",
			JSON.stringify({ connectionId: "c", expectedRevision: 0 }),
			true,
		)
		expect(result).toEqual({
			status: "ok",
			models: [
				{ upstreamId: "unknown", name: "unknown", classification: "unknown", source: "discovered" },
				{ upstreamId: "chat", name: "chat", classification: "chat", source: "discovered" },
			],
		})
	})
	it("distinguishes missing model listing from authentication rejection without echoing responses", async () => {
		const f = fixture()
		transport.mockResolvedValueOnce(new Response("secret response body", { status: 404 }))
		expect(
			await modelSettingsDiagnostic(
				f.controller as never,
				"testConnection",
				JSON.stringify({ connectionId: "c", expectedRevision: 0 }),
				true,
			),
		).toEqual({ status: "no-list", manualEntry: true, models: [] })
		transport.mockResolvedValueOnce(new Response("secret response body", { status: 401 }))
		expect(
			await modelSettingsDiagnostic(
				f.controller as never,
				"testConnection",
				JSON.stringify({ connectionId: "c", expectedRevision: 0 }),
				true,
			),
		).toEqual({ status: "auth", models: [] })
	})
	it("rejects stale discovery results after a concurrent edit", async () => {
		const f = fixture()
		transport.mockImplementationOnce(async () => {
			f.settings.revision++
			return Response.json({ data: [] })
		})
		await expect(
			modelSettingsDiagnostic(
				f.controller as never,
				"discoverConnectionModels",
				JSON.stringify({ connectionId: "c", expectedRevision: 0 }),
				true,
			),
		).rejects.toThrow("Settings changed")
	})
	it("captures the assembled compatible request without performing network I/O", async () => {
		const f = fixture()
		const result = (await modelSettingsDiagnostic(
			f.controller as never,
			"previewConfiguredModelRequest",
			JSON.stringify({ pick: { modelId: "m", levelId: "default" }, expectedRevision: 0 }),
			true,
		)) as { exact: boolean; request: { body: Record<string, unknown> } }
		expect(result.exact).toBe(true)
		expect(result.request.body).toMatchObject({ model: "test", custom: "value" })
		expect(result.request.body).not.toHaveProperty("reasoning_effort")
	})
})

describe("request preview headers", () => {
	it("sends the organization's locked values but keeps them redacted", async () => {
		const f = fixture()
		f.state.getRemoteConfigSettings = () =>
			({ openAiBaseUrl: "https://managed.invalid/v1", openAiHeaders: { "X-Org": "org-value" } }) as never
		const preview = (await modelSettingsDiagnostic(
			f.controller as never,
			"previewConfiguredModelRequest",
			JSON.stringify({ expectedRevision: f.settings.revision, pick: { modelId: "m", levelId: "default" } }),
			true,
		)) as { exact: boolean; request?: { url: string; headers: Record<string, string> } }
		expect(preview.exact).toBe(true)
		expect(preview.request?.url).toContain("managed.invalid")
		expect(preview.request?.headers["x-org"]).toBe("[redacted]")
		expect(JSON.stringify(preview)).not.toContain("org-value")
	})
	it("shows every line, masking anything sensitive or secret", async () => {
		const f = fixture()
		const connection = f.settings.connections[0]
		const secretRef = "settings:v1:connection:c:header-h2"
		connection.auth = { kind: "keychain", secretRef: "settings:v1:connection:c:apiKey" }
		connection.headers = [
			{ id: "h1", name: "X-Team", storage: "plain", value: "platform" },
			{ id: "h2", name: "X-Locked", storage: "secret", secretRef },
			{ id: "h3", name: "X-Api-Key", storage: "plain", value: "typed-into-a-plain-box" },
		]
		await f.state.connectionSecrets.set("settings:v1:connection:c:apiKey", "sk-preview-secret")
		await f.state.connectionSecrets.set(secretRef, "locked-secret")
		const result = (await modelSettingsDiagnostic(
			f.controller as never,
			"previewConfiguredModelRequest",
			JSON.stringify({ pick: { modelId: "m", levelId: "default" }, expectedRevision: 0 }),
			true,
		)) as { exact: boolean; request: { headers: Record<string, string> } }
		expect(result.exact).toBe(true)
		expect(result.request.headers).toMatchObject({
			authorization: "[redacted]",
			"x-team": "platform",
			"x-locked": "[redacted]",
			"x-api-key": "[redacted]",
		})
		const wire = JSON.stringify(result)
		for (const secret of ["sk-preview-secret", "locked-secret", "typed-into-a-plain-box"]) expect(wire).not.toContain(secret)
	})
})

describe("native and revision diagnostics", () => {
	it.each([
		[401, "auth"],
		[403, "auth"],
		[404, "no-list"],
		[405, "no-list"],
		[500, "network"],
	] as const)("tests native Anthropic over transport: %s", async (code, status) => {
		const f = fixture()
		f.settings.connections[0] = {
			id: "c",
			name: "Native",
			kind: "provider",
			providerId: "anthropic",
			baseUrl: null,
			headers: [],
			auth: { kind: "keychain", secretRef: "settings:v1:connection:c:apiKey" },
			defaults: {},
			requestTimeoutMs: null,
			options: {},
			secretRefs: {},
		}
		await f.state.connectionSecrets.set("settings:v1:connection:c:apiKey", "private-test-key")
		transport.mockResolvedValueOnce(new Response("private response", { status: code, headers: { "X-Secret": "private" } }))
		const result = await modelSettingsDiagnostic(
			f.controller as never,
			"testConnection",
			JSON.stringify({ connectionId: "c", expectedRevision: 0 }),
			true,
		)
		expect(result).toMatchObject({ status })
		expect(JSON.stringify(result)).not.toContain("private")
		const [url, init] = transport.mock.calls.at(-1)!
		expect(url).toBe("https://api.anthropic.com/v1/models")
		expect(new Headers(init.headers).get("x-api-key")).toBe("private-test-key")
	})
	it("returns native discovered IDs and separates connection failure from a maintained catalog", async () => {
		const f = fixture()
		f.settings.connections[0] = {
			id: "c",
			name: "Native",
			kind: "provider",
			providerId: "anthropic",
			baseUrl: null,
			headers: [],
			auth: { kind: "none" },
			defaults: {},
			requestTimeoutMs: null,
			options: {},
			secretRefs: {},
		}
		transport.mockResolvedValueOnce(Response.json({ data: [{ id: "claude-test" }] }))
		expect(
			await modelSettingsDiagnostic(
				f.controller as never,
				"testConnection",
				JSON.stringify({ connectionId: "c", expectedRevision: 0 }),
				true,
			),
		).toMatchObject({ status: "ok", models: [{ upstreamId: "claude-test" }] })
		transport.mockRejectedValueOnce(new Error("private transport details"))
		expect(
			await modelSettingsDiagnostic(
				f.controller as never,
				"testConnection",
				JSON.stringify({ connectionId: "c", expectedRevision: 0 }),
				true,
			),
		).toEqual({ status: "network", models: [] })
	})
	it("detects compatible endpoint limits without persisting them or changing overrides", async () => {
		const f = fixture()
		transport.mockResolvedValueOnce(
			Response.json({
				context_length: 64000,
				max_output_tokens: 8000,
				max_input_tokens: 56000,
				headers: { secret: "private" },
			}),
		)
		const result = await modelSettingsDiagnostic(
			f.controller as never,
			"detectConfiguredModel",
			JSON.stringify({ pick: { modelId: "m", levelId: "default" }, expectedRevision: 0 }),
			true,
		)
		expect(result).toMatchObject({
			source: "detected",
			metadata: { contextWindow: 64000, maxOutputTokens: 8000, maxInputTokens: 56000 },
		})
		expect(f.settings.models[0].overrides).toEqual({ extraBody: { custom: "value" } })
		expect(JSON.stringify(result)).not.toContain("private")
	})
	it("aborts an in-flight discovery transport and drops its result after a committed mutation", async () => {
		const f = fixture()
		let started!: () => void
		const ready = new Promise<void>((resolve) => {
			started = resolve
		})
		let signal: AbortSignal | undefined
		transport.mockImplementationOnce(
			(_url, init) =>
				new Promise((_resolve, reject) => {
					signal = init.signal
					started()
					signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
				}),
		)
		const request = modelSettingsDiagnostic(
			f.controller as never,
			"discoverConnectionModels",
			JSON.stringify({ connectionId: "c", expectedRevision: 0 }),
			true,
		)
		const refusal = expect(request).rejects.toThrow("Settings changed")
		await ready
		cancelModelSettingsDiagnostics(f.state)
		expect(signal!.aborted).toBe(true)
		await refusal
	})
})

it("does not invent a listing endpoint for a native provider with a custom base URL", async () => {
	const f = fixture()
	f.settings.connections[0] = {
		id: "c",
		name: "Native",
		auth: { kind: "none" },
		headers: [],
		defaults: {},
		requestTimeoutMs: null,
		kind: "provider",
		providerId: "bedrock",
		options: {},
		secretRefs: {},
		baseUrl: "https://example.invalid",
	} as never
	transport.mockClear()
	expect(
		await modelSettingsDiagnostic(
			f.controller as never,
			"discoverConnectionModels",
			JSON.stringify({ connectionId: "c", expectedRevision: 0 }),
			true,
		),
	).toEqual({ status: "no-list", manualEntry: true, models: [] })
	expect(transport).not.toHaveBeenCalled()
})
