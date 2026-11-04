import { createCompatibleConnection, createDefaultModelSettings } from "@shared/model-settings"
import { describe, expect, it, vi } from "vitest"
import { modelSettingsDiagnostic } from "@/core/controller/models/modelSettingsDiagnostics"
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
	const state = { connectionSecrets: new InMemoryConnectionSecretStore(), getGlobalStateKey: () => settings }
	const controller = { stateManager: state }
	return { controller, settings }
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
			),
		).toEqual({ status: "no-list", manualEntry: true, models: [] })
		transport.mockResolvedValueOnce(new Response("secret response body", { status: 401 }))
		expect(
			await modelSettingsDiagnostic(
				f.controller as never,
				"testConnection",
				JSON.stringify({ connectionId: "c", expectedRevision: 0 }),
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
			),
		).rejects.toThrow("Settings changed")
	})
	it("captures the assembled compatible request without performing network I/O", async () => {
		const f = fixture()
		const result = (await modelSettingsDiagnostic(
			f.controller as never,
			"previewConfiguredModelRequest",
			JSON.stringify({ pick: { modelId: "m", levelId: "default" }, expectedRevision: 0 }),
		)) as { exact: boolean; request: { body: Record<string, unknown> } }
		expect(result.exact).toBe(true)
		expect(result.request.body).toMatchObject({ model: "test", custom: "value" })
		expect(result.request.body).not.toHaveProperty("reasoning_effort")
	})
})
