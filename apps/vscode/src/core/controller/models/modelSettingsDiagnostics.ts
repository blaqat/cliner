import { createGateway, createHandler } from "@cline/llms"
import { isChatCompatibleModel } from "@cline/shared"
import { ModelPickSchema } from "@shared/model-settings"
import { z } from "zod"
import { modelAuthDependencies } from "@/sdk/model-settings/auth-dependencies"
import { prepareModelRequest, redactModelRequest, resolveConnectionConfig } from "@/sdk/model-settings/request-adapter"
import { configuredProviderConfig } from "@/sdk/model-settings/runtime-config"
import { ModelSettingsStore } from "@/sdk/model-settings/store"
import { resolveConfiguredPick } from "@/sdk/model-settings-resolver"
import { fetch } from "@/shared/net"
import type { Controller } from ".."

const connectionRequest = z.object({ connectionId: z.string().min(1), expectedRevision: z.number().int().nonnegative() }).strict()
const pickRequest = z.object({ pick: ModelPickSchema, expectedRevision: z.number().int().nonnegative() }).strict()
export type DiagnosticOperation =
	| "discoverConnectionModels"
	| "detectConfiguredModel"
	| "testConnection"
	| "testConfiguredModel"
	| "previewConfiguredModelRequest"

export async function modelSettingsDiagnostic(
	controller: Controller,
	operation: DiagnosticOperation,
	json: string,
): Promise<unknown> {
	const state = controller.stateManager
	const settings = new ModelSettingsStore(state).get()
	const raw = JSON.parse(json)
	const input =
		operation === "discoverConnectionModels" || operation === "testConnection"
			? connectionRequest.parse(raw)
			: pickRequest.parse(raw)
	if (input.expectedRevision !== settings.revision) throw new Error("Settings changed. Refresh and try again.")
	const current = () => {
		if (new ModelSettingsStore(state).get().revision !== settings.revision)
			throw new Error("Settings changed during this request. Try again.")
	}
	if ("connectionId" in input) {
		const connection = settings.connections.find((c) => c.id === input.connectionId)
		if (!connection) throw new Error("Connection is unavailable")
		const config = await resolveConnectionConfig(connection, modelAuthDependencies(state))
		if (connection.kind === "provider") {
			const models = createGateway().listModels(connection.providerId)
			current()
			return {
				status: "catalog",
				models: models.filter(isChatCompatibleModel).map((m) => ({
					upstreamId: m.id,
					name: m.name,
					classification: m.operation === "language" ? "chat" : "unknown",
					source: "catalog",
				})),
			}
		}
		if (!config.baseUrl) throw new Error("Connection URL is missing")
		const headers = new Headers(config.headers)
		if (config.apiKey) headers.set("Authorization", `Bearer ${config.apiKey}`)
		let response: Response
		try {
			response = await fetch(`${config.baseUrl.replace(/\/$/, "")}/models`, {
				headers,
				signal: AbortSignal.timeout(config.timeoutMs ?? settings.requestTimeoutMs ?? 30000),
			})
		} catch {
			current()
			return { status: "network", models: [] }
		}
		current()
		if (response.status === 401 || response.status === 403) return { status: "auth", models: [] }
		if (response.status === 404 || response.status === 405) return { status: "no-list", manualEntry: true, models: [] }
		if (!response.ok) return { status: "network", models: [] }
		const result = z
			.object({
				data: z.array(
					z
						.object({
							id: z.string(),
							name: z.string().optional(),
							operation: z.string().optional(),
							modalities: z.object({ output: z.array(z.string()).optional() }).optional(),
						})
						.passthrough(),
				),
			})
			.parse(await response.json())
		const models = result.data.flatMap((m) => {
			const classified = m.operation
				? ["chat", "language"].includes(m.operation)
					? "chat"
					: [
								"embedding",
								"embeddings",
								"image-generation",
								"speech-generation",
								"video-generation",
								"transcription",
							].includes(m.operation)
						? "non-chat"
						: "unknown"
				: m.modalities?.output
					? m.modalities.output.includes("text")
						? "chat"
						: "non-chat"
					: /^(?:text-embedding-|embedding-|embed-|nomic-embed-)/i.test(m.id)
						? "non-chat"
						: "unknown"
			return classified === "non-chat"
				? []
				: [{ upstreamId: m.id, name: m.name ?? m.id, classification: classified, source: "discovered" }]
		})
		current()
		return { status: "ok", models }
	}
	const config = await configuredProviderConfig(settings, input.pick, modelAuthDependencies(state))
	if (operation === "detectConfiguredModel") {
		const model = createGateway()
			.listModels(config.providerId)
			.find((m) => m.id === config.modelId)
		current()
		// Catalog facts are returned as suggestions; user overrides are never overwritten.
		return {
			modelId: input.pick.modelId,
			source: "catalog",
			metadata: model
				? {
						contextWindow: model.contextWindow ?? null,
						maxOutputTokens: model.maxOutputTokens ?? null,
					}
				: {},
			fetchedAt: Date.now(),
		}
	}

	if (operation === "previewConfiguredModelRequest") {
		if (["bedrock", "vertex", "claude-code", "qwen-code", "openai-codex", "opencode"].includes(config.providerId))
			return { exact: false, reason: "This provider does not support HTTP request capture" }
		const gateway = createGateway()
		const provider = gateway.listProviders().find((p) => p.id === config.providerId)
		if (!provider) throw new Error("Provider is unavailable")
		const resolved = resolveConfiguredPick(settings, input.pick)
		const model = gateway.listModels(config.providerId).find((m) => m.id === config.modelId) ?? {
			id: config.modelId!,
			name: config.modelId!,
			providerId: config.providerId,
			capabilities: [],
		}
		let captured: unknown
		const stop = new Error("Captured")
		const prepared = await prepareModelRequest(
			{
				...resolved,
				requestTimeoutMs: settings.requestTimeoutMs,
				request: { providerId: config.providerId, modelId: config.modelId!, messages: [] },
				context: { provider, model, config: { providerId: config.providerId } },
				fetch: (async (url: RequestInfo | URL, init?: RequestInit) => {
					captured = {
						url: String(url),
						method: init?.method ?? "GET",
						headers: {},
						body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
					}
					throw stop
				}) as unknown as typeof globalThis.fetch,
			},
			modelAuthDependencies(state),
		)
		try {
			for await (const _chunk of createHandler({ ...config, fetch: prepared.config.fetch }).createMessage(
				"Reply with OK.",
				[{ role: "user", content: "Connection test" }],
			)) {
			}
		} catch {
			if (!captured) return { exact: false, reason: "This provider did not expose a capturable HTTP request" }
		}
		current()
		const result = captured as { url: string; headers: Record<string, string>; body: unknown }
		const url = new URL(result.url)
		for (const key of [...url.searchParams.keys()])
			if (/key|token|secret|signature|credential/i.test(key)) url.searchParams.set(key, "[redacted]")
		url.username = ""
		url.password = ""
		result.url = url.toString()
		for (const key of Object.keys(result.headers)) result.headers[key] = "[redacted]"
		return { exact: true, request: redactModelRequest(result) }
	}

	try {
		for await (const _chunk of createHandler(config).createMessage("Reply with OK.", [
			{ role: "user", content: "Connection test" },
		])) {
			// Do not return provider text or response headers to the webview.
		}
		current()
		return { status: "ok" }
	} catch {
		current()
		return { status: "inference-failed" }
	}
}
