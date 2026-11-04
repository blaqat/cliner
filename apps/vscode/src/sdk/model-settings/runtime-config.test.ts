import { createHandler } from "@cline/llms"
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
