import { createGateway, createHandler, registerHandler, registerProvider } from "@cline/llms"
import { ConnectionOptionsSchema, createDefaultModelSettings, ModelProviderOptionsSchema } from "@shared/model-settings"
import { describe, expect, it, vi } from "vitest"
import { InMemoryConnectionSecretStore } from "./connection-secret-store"
import { connectionProviderOptions, providerOptionMappings } from "./provider-options"
import { configuredProviderConfig } from "./runtime-config"

const transport = vi.hoisted(() =>
	vi.fn(
		async () =>
			new Response(
				[
					{ type: "response.created", response: { id: "resp_test", created_at: 1, model: "gpt-5" } },
					{ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_test" } },
					{ type: "response.output_text.delta", item_id: "msg_test", delta: "Hello" },
					{
						type: "response.output_item.done",
						output_index: 0,
						item: {
							type: "message",
							id: "msg_test",
							content: [{ type: "output_text", text: "Hello", annotations: [] }],
						},
					},
					{ type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
				]
					.map((event) => `data: ${JSON.stringify(event)}\n\n`)
					.join(""),
				{ headers: { "content-type": "text/event-stream" } },
			),
	),
)
vi.mock("@/shared/net", () => ({ fetch: transport }))

describe("configured runtime projection", () => {
	it("requires every declared connection and model option to have a provider projection", () => {
		const mapped = new Set(Object.values(providerOptionMappings).flatMap((m) => Object.keys(m)))
		for (const field of [...Object.keys(ConnectionOptionsSchema.shape), ...Object.keys(ModelProviderOptionsSchema.shape)])
			expect(mapped.has(field), field).toBe(true)
	})
	it("carries native intent through the direct handler to the request body", async () => {
		const settings = createDefaultModelSettings()
		settings.connections.push({
			id: "native",
			name: "Native",
			kind: "provider",
			providerId: "openai-native",
			baseUrl: "https://example.test/v1",
			auth: { kind: "environment", variable: "TEST_KEY" },
			headers: [],
			requestTimeoutMs: null,
			defaults: {},
			options: {},
			secretRefs: {},
		})
		settings.models.push({
			id: "row",
			connectionId: "native",
			upstreamId: "gpt-5",
			name: "Test",
			kind: "chat",
			providerOptions: {},
			overrides: { verbosity: "low", systemRole: "developer" },
		})
		const config = await configuredProviderConfig(
			settings,
			{ modelId: "row", levelId: "default" },
			{ secrets: new InMemoryConnectionSecretStore(), environment: { TEST_KEY: "fake" } },
		)
		expect(config.settingsRequestIntent).toMatchObject({ verbosity: "low", systemRole: "developer" })
		transport.mockClear()
		const chunks = []
		for await (const chunk of createHandler(config).createMessage("System", [{ role: "user", content: "Hello" }]))
			chunks.push(chunk)
		expect(chunks).not.toEqual(expect.arrayContaining([expect.objectContaining({ success: false })]))
		expect(transport).toHaveBeenCalled()
		const call = transport.mock.calls[0] as unknown as [unknown, RequestInit]
		const body = JSON.parse(String(call[1].body))
		expect(body.text.verbosity).toBe("low")
	})
	it("leaves tools and images off unless someone says yes", async () => {
		const capabilitiesFor = async (overrides: Record<string, unknown>) => {
			const settings = createDefaultModelSettings()
			settings.connections.push({
				id: "gateway",
				name: "Gateway",
				kind: "openai-compatible",
				baseUrl: "https://example.test/v1",
				auth: { kind: "none" },
				headers: [],
				requestTimeoutMs: null,
				defaults: {},
				apiFormat: "chat",
				azureApiVersion: null,
			} as never)
			settings.models.push({
				id: "row",
				connectionId: "gateway",
				upstreamId: "tuned",
				name: "",
				kind: "unknown",
				providerOptions: {},
				overrides,
			} as never)
			const config = await configuredProviderConfig(
				settings,
				{ modelId: "row", levelId: "default" },
				{ secrets: new InMemoryConnectionSecretStore(), environment: {} },
			)
			return config.knownModels?.[config.modelId!].capabilities
		}
		expect(await capabilitiesFor({})).toEqual(["text"])
		expect(await capabilitiesFor({ reasoning: "yes" })).toEqual(["reasoning"])
		expect(await capabilitiesFor({ tools: "yes" })).toEqual(["tools"])
		expect(await capabilitiesFor({ images: "yes" })).toEqual(["images"])
		expect(await capabilitiesFor({ tools: "no", images: "no" })).toEqual(["text"])
	})
	it("supports identity-only Vertex and projects all resolved options into the SDK config", async () => {
		const settings = createDefaultModelSettings()
		settings.connections.push({
			id: "vertex",
			name: "Vertex",
			kind: "provider",
			providerId: "vertex",
			baseUrl: null,
			auth: { kind: "none" },
			headers: [],
			requestTimeoutMs: null,
			defaults: {},
			options: { vertexProjectId: "project", vertexRegion: "us-central1" },
			secretRefs: {},
		})
		settings.models.push({
			id: "row",
			connectionId: "vertex",
			upstreamId: "gemini-test",
			name: "Test",
			kind: "chat",
			overrides: {},
			providerOptions: {},
		})
		const config = await configuredProviderConfig(
			settings,
			{ modelId: "row", levelId: "default" },
			{ secrets: new InMemoryConnectionSecretStore(), environment: {} },
		)
		expect(config.settingsProviderOptions).toMatchObject({ project: "project", location: "us-central1" })
		expect(connectionProviderOptions(settings.connections[0], { vertexProjectId: "other" })).toEqual({ project: "other" })
	})
})

// HTTP 400 terminates after request assembly. These tests inspect the real vendor
// request without invoking credential discovery or accepting a synthetic success.
describe("configured native HTTP transport", () => {
	for (const [providerId, modelId, endpoint, expectedPath, header, expectedAuth] of [
		["bedrock", "anthropic.claude-3-haiku-20240307-v1:0", "https://bedrock.test", "/model/", "authorization", "Bearer fake"],
		["vertex", "gemini-2.0-flash", "https://vertex.test/v1", "/models/gemini-2.0-flash", "x-goog-api-key", "fake"],
		["gemini", "gemini-2.0-flash", "https://gemini.test", "/v1beta/models/", "x-goog-api-key", "fake"],
		["anthropic", "claude-sonnet-4-20250514", "https://anthropic.test/v1", "/messages", "x-api-key", "fake"],
		["mistral", "mistral-small-latest", "https://mistral.test/v1", "/chat/completions", "authorization", "Bearer fake"],
	] as const) {
		it(`assembles ${providerId} URL, auth, headers and model at the HTTP boundary`, async () => {
			const settings = createDefaultModelSettings()
			settings.connections.push({
				id: "connection",
				name: providerId,
				kind: "provider",
				providerId,
				baseUrl: endpoint,
				auth: { kind: "environment", variable: "TEST_KEY" },
				headers: [{ id: "header", name: "x-settings-test", storage: "plain", value: "present" }],
				requestTimeoutMs: null,
				defaults: {},
				options: providerId === "bedrock" ? { awsRegion: "us-east-1", awsAuthentication: "api-key" } : {},
				secretRefs: {},
			})
			settings.models.push({
				id: "row",
				connectionId: "connection",
				upstreamId: modelId,
				name: "Test",
				kind: "chat",
				overrides: {},
				providerOptions: {},
			})
			const config = await configuredProviderConfig(
				settings,
				{ modelId: "row", levelId: "default" },
				{ secrets: new InMemoryConnectionSecretStore(), environment: { TEST_KEY: "fake" } },
			)
			transport.mockClear()
			transport.mockImplementation(
				async () =>
					new Response(JSON.stringify({ error: { message: "intentional test rejection" } }), {
						status: 400,
						headers: { "content-type": "application/json" },
					}),
			)
			try {
				for await (const _chunk of createHandler(config).createMessage("System", [{ role: "user", content: "Hello" }])) {
					/* drain */
				}
			} catch {
				/* Vendor adapters may throw or return a failure chunk. */
			}
			expect(transport).toHaveBeenCalledOnce()
			const [url, init] = transport.mock.calls[0] as unknown as [string, RequestInit]
			expect(String(url)).toContain(expectedPath)
			expect(String(url)).toContain(new URL(endpoint).hostname)
			expect(new Headers(init.headers).get(header)).toBe(expectedAuth)
			expect(new Headers(init.headers).get("x-settings-test")).toBe("present")
			const body = JSON.parse(String(init.body))
			if (providerId === "anthropic" || providerId === "mistral") expect(body.model).toBe(modelId)
			else expect(decodeURIComponent(String(url))).toContain(modelId)
		})
	}
	it.each([
		"keychain",
		"azure-identity",
	] as const)("sends Azure Responses deployment and version using %s auth", async (authKind) => {
		const settings = createDefaultModelSettings()
		const secrets = new InMemoryConnectionSecretStore()
		await secrets.set("settings:v1:connection:connection:apiKey", "fake")
		settings.connections.push({
			id: "connection",
			name: "Azure",
			kind: "openai-compatible",
			apiFormat: "responses",
			baseUrl: "https://settings-test.openai.azure.com/openai/deployments/test-deployment",
			azureApiVersion: "2025-04-01-preview",
			auth:
				authKind === "keychain"
					? { kind: "keychain", secretRef: "settings:v1:connection:connection:apiKey" }
					: { kind: "azure-identity" },
			headers: [],
			requestTimeoutMs: null,
			defaults: {},
		})
		settings.models.push({
			id: "row",
			connectionId: "connection",
			upstreamId: "gpt-5",
			name: "Test",
			kind: "chat",
			overrides: {},
			providerOptions: {},
		})
		const config = await configuredProviderConfig(
			settings,
			{ modelId: "row", levelId: "default" },
			{ secrets, environment: {}, azureIdentity: async () => "identity-token" },
		)
		transport.mockClear()
		transport.mockImplementation(
			async () =>
				new Response(JSON.stringify({ error: { message: "intentional test rejection" } }), {
					status: 400,
					headers: { "content-type": "application/json" },
				}),
		)
		try {
			for await (const _chunk of createHandler(config).createMessage("System", [{ role: "user", content: "Hello" }])) {
				/* drain */
			}
		} catch {
			/* Failure response is intentional. */
		}
		expect(transport).toHaveBeenCalledOnce()
		const [url, init] = transport.mock.calls[0] as unknown as [string, RequestInit]
		expect(String(url)).toContain("settings-test.openai.azure.com")
		expect(String(url)).toContain("/responses")
		expect(new URL(String(url)).searchParams.get("api-version")).toBe("2025-04-01-preview")
		expect(JSON.parse(String(init.body)).model).toBe("test-deployment")
		const headers = new Headers(init.headers)
		if (authKind === "keychain") expect(headers.get("api-key")).toBe("fake")
		else {
			expect(headers.get("authorization")).toBe("Bearer identity-token")
			expect(headers.get("api-key")).toBeNull()
		}
	})

	it("admits every provider in the actual SDK registry without a fork allowlist", async () => {
		const providers = createGateway().listProviders()
		expect(providers.length).toBeGreaterThan(4)
		for (const provider of providers) {
			const settings = createDefaultModelSettings()
			settings.connections.push({
				id: "connection",
				name: provider.id,
				kind: "provider",
				providerId: provider.id,
				baseUrl: "https://provider.test/v1",
				auth: { kind: "environment", variable: "TEST_KEY" },
				headers: [],
				requestTimeoutMs: null,
				defaults: {},
				options: {},
				secretRefs: {},
			})
			settings.models.push({
				id: "row",
				connectionId: "connection",
				upstreamId: "test-model",
				name: "Test",
				kind: "chat",
				overrides: {},
				providerOptions: {},
			})
			const config = await configuredProviderConfig(
				settings,
				{ modelId: "row", levelId: "default" },
				{ secrets: new InMemoryConnectionSecretStore(), environment: { TEST_KEY: "fake" } },
			)
			expect(config.providerId, provider.id).toBe(provider.id)
			expect(config.apiKey, provider.id).toBe("fake")
			expect(config.baseUrl, provider.id).toBe("https://provider.test/v1")
		}
	})
})

it("maps every actual provider registry option into configured runtime admission", () => {
	const aliases: Record<string, string> = {
		"gcp.projectId": "project",
		"gcp.region": "location",
		"aws.accessKey": "accessKeyId",
		"aws.secretKey": "secretAccessKey",
	}
	for (const provider of createGateway().listProviders()) {
		const slots = new Set(Object.values(providerOptionMappings[provider.id] ?? {}))
		for (const field of provider.metadata?.configFields ?? []) {
			if (["apiKey", "baseUrl"].includes(field.path)) continue
			const slot = aliases[field.path] ?? field.path.replace(/^(aws|oca)\./, "")
			expect(slots.has(slot), `${provider.id}: ${field.path}`).toBe(true)
		}
	}
})

for (const [providerId, options, expected] of [
	[
		"qwen-code",
		{ qwenApiLine: "china", qwenCodeOauthPath: "/isolated/oauth.json" },
		{ apiLine: "china", oauthPath: "/isolated/oauth.json" },
	],
	["oca", { ocaMode: "internal", ocaUsePromptCache: false }, { mode: "internal", usePromptCache: false }],
] as const) {
	it(`projects explicit ${providerId} registry controls without losing false`, async () => {
		const settings = createDefaultModelSettings()
		settings.connections.push({
			id: "connection",
			name: providerId,
			kind: "provider",
			providerId,
			baseUrl: null,
			auth: { kind: "none" },
			headers: [],
			requestTimeoutMs: null,
			defaults: {},
			options,
			secretRefs: {},
		})
		settings.models.push({
			id: "row",
			connectionId: "connection",
			upstreamId: "test",
			name: "Test",
			kind: "chat",
			overrides: {},
			providerOptions: {},
		})
		const config = await configuredProviderConfig(
			settings,
			{ modelId: "row", levelId: "default" },
			{ secrets: new InMemoryConnectionSecretStore(), environment: {} },
		)
		expect(config.settingsProviderOptions).toMatchObject(expected)
	})
}

// These fixtures opt into configured admission directly. No production rollout
// flag, shared provider store, environment credential lookup or keychain is used.
async function providerWireFixture(
	providerId: string,
	options: Record<string, unknown> = {},
	providerOptions: Record<string, unknown> = {},
	maxInputTokens?: number,
) {
	const settings = createDefaultModelSettings()
	settings.connections.push({
		id: "wire",
		name: providerId,
		kind: "provider",
		providerId,
		baseUrl: "https://provider-wire.test/v1",
		auth: { kind: "environment", variable: "WIRE_KEY" },
		headers: [],
		requestTimeoutMs: null,
		defaults: {},
		options,
		secretRefs: {},
	})
	settings.models.push({
		id: "wire-model",
		connectionId: "wire",
		upstreamId: providerId === "ollama" ? "test-local" : "anthropic/claude-3-7-sonnet-20250219",
		name: "Wire test",
		kind: "chat",
		overrides: { contextWindow: 16384, ...(maxInputTokens !== undefined ? { maxInputTokens } : {}) },
		providerOptions,
	})
	return configuredProviderConfig(
		settings,
		{ modelId: "wire-model", levelId: "default" },
		{
			secrets: new InMemoryConnectionSecretStore(),
			environment: { WIRE_KEY: "fake" },
		},
	)
}

async function captureProviderWire(config: Awaited<ReturnType<typeof providerWireFixture>>) {
	transport.mockClear()
	transport.mockImplementation(
		async () =>
			new Response(JSON.stringify({ error: { message: "test rejection" } }), {
				status: 400,
				headers: { "content-type": "application/json" },
			}),
	)
	try {
		for await (const _chunk of createHandler(config).createMessage("Cacheable system", [
			{ role: "user", content: "Hello" },
		])) {
			/* drain */
		}
	} catch {
		/* Intentional HTTP rejection after request construction. */
	}
	expect(transport).toHaveBeenCalledOnce()
	const [, init] = transport.mock.calls[0] as unknown as [unknown, RequestInit]
	const headers: Record<string, string> = {}
	new Headers(init.headers).forEach((value, key) => {
		headers[key] = value
	})
	return { body: JSON.parse(String(init.body)), headers }
}

describe("configured provider option consumers", () => {
	it.each([true, false])("consumes OCA usePromptCache=%s at HTTP boundary", async (enabled) => {
		const config = await providerWireFixture("oca", { ocaUsePromptCache: enabled })
		const { body } = await captureProviderWire(config)
		expect(JSON.stringify(body).includes('"cache_control"')).toBe(enabled)
	})

	// These legacy fields have no SDK request consumer today. Retain them for
	// fidelity, but do not invent a new header, body field or limit policy.
	it.each([
		["openrouter", { openRouterProviderSorting: "throughput" }, {}],
		["aihubmix", { aihubmixAppCode: "test-app" }, {}],
		["fireworks", {}, { fireworksModelMaxCompletionTokens: 1234, fireworksModelMaxTokens: 5678 }],
		["lmstudio", {}, { lmStudioMaxTokens: "4321" }],
	] as const)("records unused %s legacy options without inventing wire behavior", async (provider, options, modelOptions) => {
		const baseline = await captureProviderWire(await providerWireFixture(provider))
		const config = await providerWireFixture(provider, options, modelOptions)
		expect(config.settingsProviderOptions).toEqual(
			connectionProviderOptions(
				{
					id: "wire",
					name: provider,
					kind: "provider",
					providerId: provider,
					baseUrl: null,
					auth: { kind: "none" },
					headers: [],
					requestTimeoutMs: null,
					defaults: {},
					options: {},
					secretRefs: {},
				},
				{ ...options, ...modelOptions },
			),
		)
		expect(await captureProviderWire(config)).toEqual(baseline)
	})

	it("uses explicit Ollama num_ctx as the resolved context and native HTTP option", async () => {
		const config = await providerWireFixture("ollama", {}, { ollamaApiOptionsCtxNum: "65536" })
		expect(config.maxInputTokens).toBe(65536)
		expect(config.knownModels?.[config.modelId!].contextWindow).toBe(65536)
		const { body } = await captureProviderWire(config)
		expect(body.options.num_ctx).toBe(65536)
	})
	it("preserves the generic input cap fallback while explicit Ollama context takes priority", async () => {
		const fallback = await providerWireFixture("ollama", {}, {}, 8192)
		expect((await captureProviderWire(fallback)).body.options.num_ctx).toBe(8192)
		const explicit = await providerWireFixture("ollama", {}, { ollamaApiOptionsCtxNum: "65536" }, 8192)
		expect((await captureProviderWire(explicit)).body.options.num_ctx).toBe(65536)
	})

	it("uses resolved Ollama context when its explicit option is absent", async () => {
		const { body } = await captureProviderWire(await providerWireFixture("ollama"))
		expect(body.options.num_ctx).toBe(16384)
	})

	it.each([
		"0",
		"-1",
		"broken",
		"1.5",
		"Infinity",
	])("refuses invalid explicit Ollama context %s before transport", async (value) => {
		transport.mockClear()
		await expect(providerWireFixture("ollama", {}, { ollamaApiOptionsCtxNum: value })).rejects.toThrow(
			"Ollama context must be a positive integer",
		)
		expect(transport).not.toHaveBeenCalled()
	})
	it("treats an empty Ollama context field as unset", async () => {
		const { body } = await captureProviderWire(await providerWireFixture("ollama", {}, { ollamaApiOptionsCtxNum: "" }))
		expect(body.options.num_ctx).toBe(16384)
	})

	it.each([true, false])("records unused LiteLLM prompt cache=%s without inventing a cache route", async (enabled) => {
		const { body } = await captureProviderWire(await providerWireFixture("litellm", { liteLlmUsePromptCache: enabled }))
		expect(JSON.stringify(body).includes('"cache_control"')).toBe(false)
	})
	it.each([true, false])("consumes Bedrock prompt cache=%s", async (enabled) => {
		const config = await providerWireFixture(
			"bedrock",
			{
				awsAuthentication: "api-key",
				awsRegion: "us-east-1",
			},
			{
				awsBedrockUsePromptCache: enabled,
			},
		)
		const { body } = await captureProviderWire(config)
		expect(JSON.stringify(body).includes('"cachePoint"')).toBe(enabled)
	})
	it.each([
		"oca",
		"litellm",
		"bedrock",
	])("keeps %s legacy cache behavior without configured request intent", async (provider) => {
		const options =
			provider === "oca"
				? { ocaUsePromptCache: false }
				: provider === "litellm"
					? { liteLlmUsePromptCache: false }
					: { awsAuthentication: "api-key", awsRegion: "us-east-1" }
		const config = await providerWireFixture(
			provider,
			options,
			provider === "bedrock" ? { awsBedrockUsePromptCache: false } : {},
		)
		const { body } = await captureProviderWire({ ...config, settingsRequestIntent: undefined })
		expect(JSON.stringify(body).includes(provider === "bedrock" ? '"cachePoint"' : '"cache_control"')).toBe(
			provider !== "litellm",
		)
	})
})

vi.mock("vscode", () => ({ lm: { selectChatModels: vi.fn(async () => []) } }))
vi.mock("@/shared/services/Logger", () => ({ Logger: { warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

describe("configured VS Code LM selector consumer", () => {
	it.each([
		{ vendor: "copilot", family: "openai/gpt-4o", version: "1.0", id: "model/id" },
		{ vendor: "copilot", family: "claude-sonnet", id: "model/id" },
		{ id: "model/id" },
	])("passes the complete selector to vscode.lm.selectChatModels: %j", async (selector) => {
		const { VSCODE_LM_PROVIDER_COLLECTION } = await import("../vscode-lm/register-vscode-lm")
		const { VsCodeLmHandler } = await import("../vscode-lm/vscode-lm-handler")
		const vscode = await import("vscode")
		registerProvider(VSCODE_LM_PROVIDER_COLLECTION)
		registerHandler("vscode-lm", (config) => new VsCodeLmHandler(config))
		vi.mocked(vscode.lm.selectChatModels).mockClear()
		const config = await providerWireFixture("vscode-lm", {}, { actModeVsCodeLmModelSelector: selector })
		// A no-model reply stops before sendRequest while exercising the real
		// SDK registered handler and the host selection API boundary.
		await expect(async () => {
			for await (const _chunk of createHandler(config).createMessage("System", [])) {
				/* drain */
			}
		}).rejects.toThrow("No VS Code language model matched selector")
		expect(vscode.lm.selectChatModels).toHaveBeenCalledExactlyOnceWith(selector)
		expect(config.knownModels?.[config.modelId!].id).toBe(config.modelId)
	})
})
