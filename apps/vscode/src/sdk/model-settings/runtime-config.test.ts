import { createGateway, createHandler } from "@cline/llms"
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
