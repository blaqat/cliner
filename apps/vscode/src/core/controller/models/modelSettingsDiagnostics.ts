import { createGateway, createHandler } from "@cline/llms"
import { type Connection, ModelPickSchema } from "@shared/model-settings"
import { z } from "zod"
import { modelAuthDependencies } from "@/sdk/model-settings/auth-dependencies"
import {
	assertConfiguredModelRequestAllowed,
	assertConnectionAllowed,
	catalogModelValues,
	managedConnection,
	rememberDetectedModelMetadata,
	resolveEffectiveConfiguredPick,
} from "@/sdk/model-settings/host-settings"
import { prepareModelRequest, redactModelRequest, resolveConnectionConfig } from "@/sdk/model-settings/request-adapter"
import { modelSettingsRolloutEnabled } from "@/sdk/model-settings/rollout"
import { configuredProviderConfig } from "@/sdk/model-settings/runtime-config"
import { ModelSettingsStore } from "@/sdk/model-settings/store"
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

const PREVIEW_SENSITIVE_HEADER = /authorization|key|token|secret|cookie|credential/i
const PREVIEW_PLAIN_HEADERS = new Set(["accept", "content-type", "user-agent"])
/** Every header line the request would carry. A value shows only if it's plain text the person typed or a routine one. */
function previewHeaders(headers: HeadersInit | undefined, connection: Connection): Record<string, string> {
	const typed = new Set(connection.headers.flatMap((h) => (h.storage === "plain" ? [h.name.toLowerCase()] : [])))
	const lines: Record<string, string> = {}
	new Headers(headers).forEach((value, name) => {
		const shown = !PREVIEW_SENSITIVE_HEADER.test(name) && (PREVIEW_PLAIN_HEADERS.has(name) || typed.has(name))
		lines[name] = shown ? value : "[redacted]"
	})
	return lines
}

const diagnostics = new WeakMap<object, Set<AbortController>>()
/** Called only after a committed host mutation. Also drop results from edits in other windows. */
export function cancelModelSettingsDiagnostics(state: object): void {
	for (const pending of diagnostics.get(state) ?? []) pending.abort()
	diagnostics.delete(state)
}

export async function modelSettingsDiagnostic(
	controller: Controller,
	operation: DiagnosticOperation,
	json: string,
	enabled?: boolean,
): Promise<unknown> {
	if (!modelSettingsRolloutEnabled(enabled)) throw new Error("Model settings rollout is disabled")
	const state = controller.stateManager
	const settings = new ModelSettingsStore(state).get()
	const raw = JSON.parse(json)
	const input =
		operation === "discoverConnectionModels" || operation === "testConnection"
			? connectionRequest.parse(raw)
			: pickRequest.parse(raw)
	if (input.expectedRevision !== settings.revision) throw new Error("Settings changed. Refresh and try again.")
	const cancellation = new AbortController()
	const pending = diagnostics.get(state) ?? new Set<AbortController>()
	pending.add(cancellation)
	diagnostics.set(state, pending)
	try {
		const current = () => {
			if (cancellation.signal.aborted) throw new Error("Settings changed during this request. Try again.")
			if (new ModelSettingsStore(state).get().revision !== settings.revision)
				throw new Error("Settings changed during this request. Try again.")
		}
		if ("connectionId" in input) {
			const stored = settings.connections.find((c) => c.id === input.connectionId)
			if (!stored) throw new Error("Connection is unavailable")
			assertConnectionAllowed(state, stored)
			const connection = managedConnection(state, stored)
			const providerId = connection.kind === "provider" ? connection.providerId : "openai-compatible"
			const nativeBases: Record<string, string> = {
				anthropic: "https://api.anthropic.com/v1",
				"openai-native": "https://api.openai.com/v1",
				openrouter: "https://openrouter.ai/api/v1",
				groq: "https://api.groq.com/openai/v1",
				deepseek: "https://api.deepseek.com/v1",
				mistral: "https://api.mistral.ai/v1",
				gemini: "https://generativelanguage.googleapis.com/v1beta",
				ollama: "http://localhost:11434/api",
				lmstudio: "http://localhost:1234/v1",
			}
			if (connection.kind === "provider" && !nativeBases[providerId]) {
				current()
				return { status: "no-list", manualEntry: true, models: [] }
			}
			let config: Awaited<ReturnType<typeof resolveConnectionConfig>>
			try {
				config = await resolveConnectionConfig(connection, modelAuthDependencies(state))
			} catch {
				current()
				return { status: "auth", models: [] }
			}

			config.baseUrl ??= typeof config.options?.baseUrl === "string" ? config.options.baseUrl : nativeBases[providerId]

			if (!config.baseUrl) throw new Error("Connection URL is missing")
			const headers = new Headers(config.headers)
			if (config.apiKey) {
				if (providerId === "anthropic") {
					headers.set("x-api-key", config.apiKey)
					headers.set("anthropic-version", "2023-06-01")
				} else if (providerId === "gemini") headers.set("x-goog-api-key", config.apiKey)
				else headers.set("Authorization", `Bearer ${config.apiKey}`)
			}
			let response: Response
			try {
				response = await fetch(
					`${config.baseUrl.replace(/\/$/, "")}/${providerId === "ollama" ? "tags" : providerId === "openrouter" && operation === "testConnection" ? "auth/key" : "models"}`,
					{
						headers,
						signal: AbortSignal.any([
							cancellation.signal,
							AbortSignal.timeout(config.timeoutMs ?? settings.requestTimeoutMs ?? 30000),
						]),
					},
				)
			} catch {
				current()
				return { status: "network", models: [] }
			}
			current()
			if (response.status === 401 || response.status === 403) return { status: "auth", models: [] }
			if (response.status === 404 || response.status === 405) return { status: "no-list", manualEntry: true, models: [] }
			if (!response.ok) return { status: "network", models: [] }
			if (providerId === "openrouter" && operation === "testConnection") return { status: "ok", models: [] }
			let body: { data?: unknown; models?: Array<{ name: string; displayName?: string }> }
			try {
				body = await response.json()
			} catch {
				current()
				return { status: "network", models: [] }
			}
			const normalized = body.data
				? body
				: {
						data:
							body.models?.map((m) => ({
								id: providerId === "gemini" ? m.name.replace(/^models\//, "") : m.name,
								name: m.displayName ?? m.name,
							})) ?? [],
					}
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
				.parse(normalized)
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
		await assertConfiguredModelRequestAllowed(state, settings, input.pick)
		const config = await configuredProviderConfig(settings, input.pick, modelAuthDependencies(state), { state })
		current()
		const transportFetch = config.fetch ?? fetch
		config.fetch = ((url, init) =>
			transportFetch(url, {
				...init,
				signal: init?.signal ? AbortSignal.any([init.signal, cancellation.signal]) : cancellation.signal,
			})) as typeof fetch
		if (operation === "detectConfiguredModel") {
			const model = createGateway()
				.listModels(config.providerId)
				.find((m) => m.id === config.modelId)
			const resolved = resolveEffectiveConfiguredPick(state, settings, input.pick)
			if (resolved.connection.kind === "openai-compatible" && config.baseUrl) {
				const headers = new Headers(config.headers)
				if (config.apiKey) headers.set("Authorization", `Bearer ${config.apiKey}`)
				try {
					const response = await fetch(
						`${config.baseUrl.replace(/\/$/, "")}/models/${encodeURIComponent(config.modelId!)}`,
						{
							headers,
							signal: AbortSignal.any([cancellation.signal, AbortSignal.timeout(config.timeoutMs ?? 30000)]),
						},
					)
					if (response.ok) {
						const body = (await response.json()) as Record<string, unknown>
						const metadata: Record<string, number> = {}
						for (const [key, candidates] of Object.entries({
							contextWindow: ["context_window", "context_length"],
							maxOutputTokens: ["max_output_tokens"],
							maxInputTokens: ["max_input_tokens"],
						})) {
							const value = candidates
								.map((field) => body[field])
								.find((v) => typeof v === "number" && Number.isInteger(v) && v > 0)
							if (typeof value === "number") metadata[key] = value
						}
						current()
						rememberDetectedModelMetadata(state, input.pick.modelId, settings.revision, metadata)
						return { modelId: input.pick.modelId, source: "detected", metadata, fetchedAt: Date.now() }
					}
				} catch {
					current()
				}
			}
			current()
			if (resolved.connection.kind === "provider" && !model)
				return {
					modelId: input.pick.modelId,
					status: "no-list",
					manualEntry: true,
					source: "unknown",
					metadata: {},
					fetchedAt: Date.now(),
				}
			// Catalog facts are returned as suggestions; user overrides are never overwritten.
			return {
				modelId: input.pick.modelId,
				source: "catalog",
				metadata: model ? catalogModelValues(resolved.model, resolved.connection) : {},
				fetchedAt: Date.now(),
			}
		}

		if (operation === "previewConfiguredModelRequest") {
			if (["bedrock", "vertex", "claude-code", "qwen-code", "openai-codex", "opencode"].includes(config.providerId))
				return { exact: false, reason: "This provider does not support HTTP request capture" }
			const gateway = createGateway()
			const provider = gateway.listProviders().find((p) => p.id === config.providerId)
			if (!provider) throw new Error("Provider is unavailable")
			const resolved = resolveEffectiveConfiguredPick(state, settings, input.pick)
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
							url: url instanceof Request ? url.url : String(url),
							method: init?.method ?? (url instanceof Request ? url.method : "GET"),
							headers: previewHeaders(
								init?.headers ?? (url instanceof Request ? url.headers : undefined),
								// A locked header's value stays the organization's: it never counts as plain text the person typed.
								state.getRemoteConfigSettings().openAiHeaders === undefined
									? resolved.connection
									: { ...resolved.connection, headers: [] },
							),
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
			// Masked name by name above, so the redactor's blanket rule for `headers` isn't needed.
			return { exact: true, request: { ...(redactModelRequest(result) as object), headers: result.headers } }
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
	} finally {
		pending.delete(cancellation)
		if (!pending.size) diagnostics.delete(state)
	}
}
