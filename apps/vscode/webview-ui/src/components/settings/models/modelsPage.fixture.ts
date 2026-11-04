import {
	applyConnectionPatch,
	type Connection,
	createDefaultModelSettings,
	type ModelLevel,
	type ModelRow,
	type ModelSettings,
	ModelSettingsSchema,
	type ModelValues,
	resolveModelValues,
} from "@shared/model-settings"
import type { ModelSettingsState } from "@shared/model-settings-state"
import type { DiscoveryResult, PreviewResult, SecretMutation } from "./modelSettingsClient"

const level = (id: string, label: string, rank: number): ModelLevel => ({
	id,
	label,
	rank,
	request: id === "default" ? { kind: "default" } : { kind: "effort", value: id },
})

export const LEVELS = [
	level("default", "Default", 0),
	level("low", "Low", 1),
	level("medium", "Medium", 2),
	level("high", "High", 3),
	level("xhigh", "XHigh", 4),
]
export const levelsUpTo = (top: number) => LEVELS.slice(0, top + 1)

export const modelRow = (
	id: string,
	connectionId: string,
	upstreamId: string,
	name: string,
	overrides: Partial<ModelValues> = {},
): ModelRow => ({
	id,
	connectionId,
	upstreamId,
	name,
	kind: "chat",
	overrides,
	providerOptions: {},
})

export const gatewayConnection = (): Connection => ({
	id: "gateway",
	name: "Company gateway",
	kind: "openai-compatible",
	baseUrl: "https://ai.acme.example/v1",
	auth: { kind: "environment", variable: "AI_GATEWAY_KEY" },
	headers: [{ id: "h1", name: "X-Team", storage: "plain", value: "platform" }],
	requestTimeoutMs: null,
	defaults: { inputPrice: 2, outputPrice: 8 },
	apiFormat: "responses",
	azureApiVersion: null,
})

/** The mockup's "Gateway with 4 models". Illustrative values for tests and stories only. */
export const gatewaySettings = (): ModelSettings => {
	const settings = createDefaultModelSettings()
	settings.revision = 7
	settings.connections = [gatewayConnection()]
	settings.models = [
		modelRow("sol", "gateway", "gpt-6-sol", "GPT-6 Sol", {
			contextWindow: 400000,
			maxOutputTokens: 64000,
			images: "yes",
			tools: "yes",
			reasoning: "yes",
			levels: levelsUpTo(4),
			streaming: "yes",
			promptCache: "yes",
			systemRole: "developer",
			inputPrice: 5,
			outputPrice: 20,
		}),
		modelRow("g54", "gateway", "gpt-5.4", "GPT-5.4", {
			contextWindow: 272000,
			maxOutputTokens: 32000,
			images: "yes",
			tools: "yes",
			reasoning: "yes",
			levels: levelsUpTo(4),
		}),
		modelRow("mini", "gateway", "gpt-5.6-mini", "GPT-5.6 Mini", {
			contextWindow: 128000,
			maxOutputTokens: 16000,
			images: "yes",
			tools: "yes",
			reasoning: "yes",
			levels: levelsUpTo(3),
		}),
		modelRow("tuned", "gateway", "acme-tuned-coder", "", { tools: "yes", streaming: "yes" }),
	]
	settings.roles.chat = { modelId: "sol", levelId: "medium" }
	settings.roles.background.pick = { modelId: "mini", levelId: "low" }
	return settings
}

const secretRefsOf = (connection: Connection) => [
	...(connection.auth.kind === "keychain" ? [connection.auth.secretRef] : []),
	...connection.headers.flatMap((header) => (header.storage === "secret" ? [header.secretRef] : [])),
	...(connection.kind === "provider" ? Object.values(connection.secretRefs) : []),
]

export interface FakeHostOptions {
	settings?: ModelSettings
	/** Keychain values by reference. Tests read these; the webview never sees them. */
	secrets?: Record<string, string>
	discovery?: Record<string, DiscoveryResult>
	test?: Record<string, DiscoveryResult>
	modelTest?: "ok" | "inference-failed"
	preview?: PreviewResult
	detected?: Partial<ModelValues>
	/** Catalog facts the host reports as metadata, by configured model ID. */
	metadata?: Record<string, Partial<ModelValues>>
	availability?: Record<string, { available: boolean; reason?: string }>
	managed?: string[]
	threadDependencies?: Record<string, string[]>
	providers?: { id: string; name: string; protocol?: string }[]
	catalog?: Record<string, Record<string, { name: string }>>
}

const DEFAULT_PROVIDERS = [
	["cline", "Cline"],
	["anthropic", "Anthropic"],
	["openai", "OpenAI Compatible"],
	["openai-native", "OpenAI"],
	["openrouter", "OpenRouter"],
	["bedrock", "Amazon Bedrock"],
	["vertex", "Vertex AI"],
	["gemini", "Gemini"],
	["ollama", "Ollama"],
	["lmstudio", "LM Studio"],
	["litellm", "LiteLLM"],
	["groq", "Groq"],
	["fireworks", "Fireworks"],
	["xai", "xAI"],
	["aihubmix", "AIHubMix"],
	["sapaicore", "SAP AI Core"],
].map(([id, name]) => ({ id, name, protocol: "openai-chat" }))

const DEFAULT_DISCOVERY: DiscoveryResult = {
	status: "ok",
	models: ["gpt-6-sol", "gpt-5.4", "gpt-5.6-mini", "acme-tuned-coder", "gpt-5.6-nano", "qwen3-coder"].map((upstreamId) => ({
		upstreamId,
		name: upstreamId,
		classification: "unknown" as const,
		source: "discovered" as const,
	})),
}

/**
 * A stand-in for the extension host's ModelsService, following the contract: revision checks, patch
 * merging, schema validation, write-only secrets and dependency refusals. Everything the Models page is
 * tested against goes through this, not a real host.
 */
export const createFakeHost = (options: FakeHostOptions = {}) => {
	let settings: ModelSettings = structuredClone(options.settings ?? createDefaultModelSettings())
	const secrets: Record<string, string> = { ...options.secrets }
	const calls: { method: string; payload: unknown }[] = []

	const state = (): ModelSettingsState => {
		const configuredSecrets: Record<string, boolean> = {}
		for (const connection of settings.connections) {
			for (const ref of secretRefsOf(connection)) {
				configuredSecrets[ref] = !!secrets[ref]
			}
		}
		const effective: ModelSettingsState["effective"] = {}
		const planning: ModelSettingsState["planning"] = {}
		const availability: ModelSettingsState["availability"] = {}
		for (const row of settings.models) {
			const connection = settings.connections.find((candidate) => candidate.id === row.connectionId)
			effective[row.id] = resolveModelValues(row.overrides, options.metadata?.[row.id], connection?.defaults ?? {})
			const contextWindow = effective[row.id].contextWindow.value
			planning[row.id] = { contextWindowKnown: contextWindow !== null, planningContextWindow: contextWindow ?? 128000 }
			const missing = connection ? secretRefsOf(connection).some((ref) => !configuredSecrets[ref]) : true
			availability[row.id] =
				options.availability?.[row.id] ??
				(missing ? { available: false, reason: "Connection credentials are missing" } : { available: true })
		}
		return structuredClone({
			settings,
			configuredSecrets,
			effective,
			planning,
			availability,
			managed: options.managed ?? [],
			migration: { status: "complete", retryable: false },
		}) as ModelSettingsState
	}

	const decode = (method: string, request: { json: string }) => {
		const payload = JSON.parse(request.json) as Record<string, unknown>
		calls.push({ method, payload })
		return payload
	}

	const reply = (value: unknown) => ({ json: JSON.stringify(value) })

	const commit = (payload: Record<string, unknown>, change: (next: ModelSettings) => void) => {
		if (payload.expectedRevision !== settings.revision) {
			throw new Error("Settings changed in another window. Refresh and try again.")
		}
		const next = structuredClone(settings)
		change(next)
		next.revision += 1
		settings = ModelSettingsSchema.parse(next)
		return reply(state())
	}

	const dependencies = (ids: string[]) => {
		const found: string[] = []
		const visit = (value: unknown, path: string) => {
			if (!value || typeof value !== "object") return
			if ("modelId" in value && ids.includes(String(value.modelId))) found.push(path)
			for (const [key, child] of Object.entries(value)) visit(child, `${path}.${key}`)
		}
		visit(settings.roles, "roles")
		visit(settings.subagents.allowed, "subagents.allowed")
		for (const id of ids) found.push(...(options.threadDependencies?.[id] ?? []).map((thread) => `thread:${thread}`))
		return found
	}

	const client = {
		getModelSettings: async (request: { json: string }) => {
			decode("getModelSettings", request)
			return reply(state())
		},
		saveConnection: async (request: { json: string }) => {
			const payload = decode("saveConnection", request)
			const input = payload.connection as { id: string }
			const mutations = (payload.secrets ?? []) as SecretMutation[]
			commit(payload, (next) => {
				const previous = next.connections.find((candidate) => candidate.id === input.id)
				const connection = applyConnectionPatch(previous, input as never)
				const refs = secretRefsOf(connection)
				for (const mutation of mutations) {
					if (mutation.operation === "set" && /^(?:[*•●]{2,})/.test(mutation.value))
						throw new Error("Supply a new credential, not a masked placeholder")
					if (!refs.includes(`settings:v1:connection:${input.id}:${mutation.field}`))
						throw new Error("Invalid or duplicate secret field")
				}
				if (previous) {
					next.connections = next.connections.map((candidate) => (candidate.id === input.id ? connection : candidate))
				} else {
					next.connections.push(connection)
				}
			})
			for (const mutation of mutations) {
				const ref = `settings:v1:connection:${input.id}:${mutation.field}`
				if (mutation.operation === "set") secrets[ref] = mutation.value
				if (mutation.operation === "delete") delete secrets[ref]
			}
			return reply(state())
		},
		saveConfiguredModels: async (request: { json: string }) => {
			const payload = decode("saveConfiguredModels", request)
			return commit(payload, (next) => {
				for (const row of payload.models as ModelRow[]) {
					const index = next.models.findIndex((model) => model.id === row.id)
					if (index < 0) next.models.push(row)
					else next.models[index] = row
				}
			})
		},
		duplicateConfiguredModel: async (request: { json: string }) => {
			const payload = decode("duplicateConfiguredModel", request)
			const row = settings.models.find((model) => model.id === payload.modelId)
			if (!row) throw new Error("Configured model is missing")
			return reply({ draft: { ...structuredClone(row), id: crypto.randomUUID(), upstreamId: "", name: "" } })
		},
		deleteConfiguredModel: async (request: { json: string }) => {
			const payload = decode("deleteConfiguredModel", request)
			const found = dependencies([payload.modelId as string])
			if (found.length) return reply({ dependencies: found })
			return commit(payload, (next) => {
				next.models = next.models.filter((model) => model.id !== payload.modelId)
			})
		},
		deleteConnection: async (request: { json: string }) => {
			const payload = decode("deleteConnection", request)
			const rows = settings.models.filter((model) => model.connectionId === payload.connectionId).map((model) => model.id)
			const found = [...rows.map((id) => `model:${id}`), ...dependencies(rows)]
			if (found.length) return reply({ dependencies: found })
			return commit(payload, (next) => {
				next.connections = next.connections.filter((connection) => connection.id !== payload.connectionId)
			})
		},
		setModelRoles: async (request: { json: string }) => {
			const payload = decode("setModelRoles", request)
			return commit(payload, (next) => {
				next.roles = payload.roles as ModelSettings["roles"]
			})
		},
		setSubagentPolicy: async (request: { json: string }) => {
			const payload = decode("setSubagentPolicy", request)
			return commit(payload, (next) => {
				next.subagents = payload.subagents as ModelSettings["subagents"]
			})
		},
		discoverConnectionModels: async (request: { json: string }) => {
			const payload = decode("discoverConnectionModels", request)
			return reply(options.discovery?.[payload.connectionId as string] ?? DEFAULT_DISCOVERY)
		},
		testConnection: async (request: { json: string }) => {
			const payload = decode("testConnection", request)
			return reply(
				options.test?.[payload.connectionId as string] ??
					options.discovery?.[payload.connectionId as string] ??
					DEFAULT_DISCOVERY,
			)
		},
		detectConfiguredModel: async (request: { json: string }) => {
			const payload = decode("detectConfiguredModel", request) as { pick: { modelId: string } }
			return reply({ modelId: payload.pick.modelId, source: "detected", metadata: options.detected ?? {}, fetchedAt: 1 })
		},
		testConfiguredModel: async (request: { json: string }) => {
			decode("testConfiguredModel", request)
			return reply({ status: options.modelTest ?? "ok" })
		},
		previewConfiguredModelRequest: async (request: { json: string }) => {
			decode("previewConfiguredModelRequest", request)
			return reply(
				options.preview ?? {
					exact: true,
					request: {
						url: "https://ai.acme.example/v1/responses",
						method: "POST",
						headers: { Authorization: "[redacted]" },
						body: { model: "gpt-6-sol", reasoning: { effort: "xhigh" }, stream: true },
					},
				},
			)
		},
		listProviders: async () => ({ providers: options.providers ?? DEFAULT_PROVIDERS }),
		resolveProviderModels: async (request: { providerId: string }) => ({
			providerId: request.providerId,
			ok: true,
			models: options.catalog?.[request.providerId] ?? {},
		}),
	}

	return {
		client,
		calls,
		secrets,
		state,
		callsTo: (method: string) =>
			calls.filter((call) => call.method === method).map((call) => call.payload as Record<string, unknown>),
		/** Everything sent to the host, as one string, to prove what did or didn't travel. */
		wire: () => JSON.stringify(calls),
	}
}

export type FakeHost = ReturnType<typeof createFakeHost>
