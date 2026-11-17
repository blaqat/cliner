import { applyCompatibleRequestIntent, applyNativeRequestIntent, type LevelRequest, type ModelRequestIntent } from "@cline/llms"
import type { GatewayProviderContext, GatewayResolvedProviderConfig, GatewayStreamRequest } from "@cline/shared"
import {
	type Connection,
	ConnectionSchema,
	type ModelRow,
	ModelRowSchema,
	type ModelValues,
	ModelValuesSchema,
} from "@shared/model-settings"
import type { ConnectionSecretStore } from "./connection-secret-store"
import { connectionProviderOptions } from "./provider-options"

const FIX = "Open Settings > Models to fix it."

export interface ConnectionAuthDependencies {
	secrets: ConnectionSecretStore
	environment: Readonly<Record<string, string | undefined>>
	sdkAccount?: (providerId: string) => Promise<GatewayResolvedProviderConfig>
	/** Optional token source. Without one an identity connection sends no credential, as the legacy path does. */
	azureIdentity?: () => Promise<string>
}
/** Construct per-request config. Never looks up a provider-wide key except an explicit sdk-account. */
export async function resolveConnectionConfig(
	connection: Connection,
	deps: ConnectionAuthDependencies,
): Promise<GatewayResolvedProviderConfig> {
	ConnectionSchema.parse(connection)
	let account: GatewayResolvedProviderConfig | undefined
	let apiKey = ""
	switch (connection.auth.kind) {
		case "keychain":
			apiKey = (await deps.secrets.get(connection.auth.secretRef)) ?? ""
			if (!apiKey.trim()) throw new Error("Connection key is missing")
			break
		case "environment":
			apiKey = deps.environment[connection.auth.variable] ?? ""
			if (!apiKey.trim()) throw new Error(`Connection environment variable ${connection.auth.variable} is empty`)
			break
		case "sdk-account":
			if (!deps.sdkAccount) throw new Error("SDK account resolver is unavailable")
			account = await deps.sdkAccount(connection.auth.providerId)
			break
		case "azure-identity":
			apiKey = (await deps.azureIdentity?.()) ?? ""
			break
		case "none":
			break
	}
	const headers: Record<string, string> = { ...account?.headers }
	for (const h of connection.headers) {
		const value = h.storage === "plain" ? h.value : await deps.secrets.get(h.secretRef)
		if (value === undefined) throw new Error("Locked connection header is missing")
		if (/[\r\n]/.test(value)) throw new Error("Invalid header value")
		headers[h.name] = value
	}
	const options: Record<string, unknown> =
		connection.kind === "provider" ? { ...connection.options } : { apiVersion: connection.azureApiVersion ?? undefined }
	if (connection.kind === "provider")
		for (const [field, ref] of Object.entries(connection.secretRefs)) {
			const value = await deps.secrets.get(ref)
			if (value === undefined) throw new Error("Provider credential is missing")
			options[field] = value
		}
	if (connection.auth.kind === "azure-identity" && apiKey.trim()) headers.Authorization = `Bearer ${apiKey}`
	return {
		...account,
		providerId:
			connection.kind === "provider"
				? connection.providerId
				: connection.apiFormat === "responses"
					? "openai-native"
					: "openai-compatible",
		...(connection.baseUrl !== null ? { baseUrl: connection.baseUrl } : {}),
		...(account
			? {}
			: { apiKey: connection.auth.kind === "azure-identity" ? "" : apiKey, apiKeyEnv: [], apiKeyResolver: undefined }),
		headers,
		options: { ...account?.options, ...connectionProviderOptions(connection, options) },
		timeoutMs: connection.requestTimeoutMs ?? undefined,
	}
}
type PrepareModelRequestInput = {
	connection: Connection
	model: ModelRow
	values: ModelValues
	levelId: string
	request: GatewayStreamRequest
	context: GatewayProviderContext
	requestTimeoutMs: number | null
	fetch?: typeof fetch
}
/** Every refusal names the model and where to fix it. */
export async function prepareModelRequest(input: PrepareModelRequestInput, deps: ConnectionAuthDependencies) {
	try {
		return await assembleModelRequest(input, deps)
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		throw new Error(
			`${input.model.name || input.model.upstreamId}: ${message}${/Open Settings/.test(message) ? "" : `. ${FIX}`}`,
			{ cause: error },
		)
	}
}
async function assembleModelRequest(input: PrepareModelRequestInput, deps: ConnectionAuthDependencies) {
	const { connection, model, levelId } = input
	ModelRowSchema.parse(model)
	if (model.kind === "non-chat") throw new Error("This model does not support chat")
	if (connection.kind === "openai-compatible" && connection.baseUrl === null) throw new Error("Connection URL is missing")
	const values = ModelValuesSchema.parse(input.values)
	if (model.connectionId !== connection.id) throw new Error("Model belongs to another connection")
	const level = values.levels.find((l) => l.id === levelId)
	if (!level) throw new Error("Saved level is unavailable")
	if (values.reasoning !== "yes" && level.request.kind !== "default") throw new Error("Reasoning is unknown or unsupported")
	const intent: ModelRequestIntent = {
		level: level.request,
		temperature: values.temperature,
		verbosity: values.verbosity,
		maxOutputTokens: values.maxOutputTokens,
		thinkingBudgetTokens: values.thinkingBudgetTokens,
		systemRole: values.systemRole,
		extraBody: values.extraBody,
	}
	const config = await resolveConnectionConfig(connection, deps)
	if (connection.kind === "provider") {
		const modelOptions = connectionProviderOptions(connection, {}, model)
		config.options = { ...config.options, ...modelOptions }
		if (typeof config.options.baseUrl === "string" && connection.baseUrl === null) config.baseUrl = config.options.baseUrl
	}
	config.timeoutMs = connection.requestTimeoutMs ?? input.requestTimeoutMs ?? undefined
	const request = { ...input.request, providerId: config.providerId, modelId: model.upstreamId, reasoning: undefined }
	const format = values.apiFormat ?? (connection.kind === "openai-compatible" ? connection.apiFormat : null)
	const transportFetch = input.fetch ?? globalThis.fetch
	// A rotated key is used by the next request, even one already inside a running turn.
	const builtKey = connection.auth.kind === "keychain" ? config.apiKey : undefined
	const withCurrentKey = async (init: RequestInit | undefined): Promise<RequestInit | undefined> => {
		if (connection.auth.kind !== "keychain" || !builtKey) return init
		const current = await deps.secrets.get(connection.auth.secretRef)
		if (!current?.trim()) throw new Error(`Connection key is missing. ${FIX}`)
		if (current === builtKey) return init
		const headers = new Headers(init?.headers)
		const stale: Array<[string, string]> = []
		headers.forEach((value, name) => {
			if (value.includes(builtKey)) stale.push([name, value])
		})
		for (const [name, value] of stale) headers.set(name, value.replaceAll(builtKey, current))
		return { ...init, headers }
	}
	const baseFetch: typeof fetch = (async (url, requestInit) => {
		const init = await withCurrentKey(requestInit)
		if (config.timeoutMs === undefined) return transportFetch(url, init)
		const timeout = AbortSignal.timeout(config.timeoutMs)
		return transportFetch(url, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout })
	}) as typeof fetch
	// Only what the SDK added for a missing key goes. A header the user configured is theirs to send.
	const configuredHeaders = new Set(Object.keys(config.headers ?? {}).map((name) => name.toLowerCase()))
	const dropUnconfiguredAuth = (headers: Headers) => {
		for (const name of ["authorization", "api-key"]) if (!configuredHeaders.has(name)) headers.delete(name)
	}
	if (connection.kind === "openai-compatible") {
		const sendsNoCredential =
			connection.auth.kind === "none" ||
			(connection.auth.kind === "azure-identity" && !configuredHeaders.has("authorization"))
		// The final vendor body is the single assembly used for sending and preview.
		// A subagent builds this at its own level, so only that level reaches the wire.
		const fetchAtLevel = (selected: LevelRequest): typeof fetch => {
			if (values.reasoning !== "yes" && selected.kind !== "default") throw new Error("Reasoning is unknown or unsupported")
			const levelIntent = { ...intent, level: selected }
			applyCompatibleRequestIntent({}, format!, levelIntent, input.context)
			return (async (url, init) => {
				if (typeof init?.body !== "string") throw new Error("Expected a serialized compatible request")
				const body = applyCompatibleRequestIntent(JSON.parse(init.body), format!, levelIntent, input.context)
				const headers = new Headers(init.headers)
				if (sendsNoCredential) dropUnconfiguredAuth(headers)
				return baseFetch(url, { ...init, headers, body: JSON.stringify(body) })
			}) as typeof fetch
		}
		config.fetch = fetchAtLevel(level.request)
		config.providerId = format === "responses" ? "openai-native" : "openai-compatible"
		request.providerId = config.providerId
		return { connectionId: connection.id, modelId: model.id, request, config, intent, fetchAtLevel }
	}
	const nativeFetch = (async (url, init) => {
		if (
			connection.auth.kind === "none" &&
			!(
				connection.kind === "provider" &&
				["bedrock", "vertex", "claude-code", "qwen-code", "openai-codex", "opencode", "sapaicore"].includes(
					connection.providerId,
				)
			)
		) {
			const headers = new Headers(init?.headers)
			dropUnconfiguredAuth(headers)
			init = { ...init, headers }
		}
		if (typeof init?.body !== "string" || !Object.keys(intent.extraBody).length) return baseFetch(url, init)
		return baseFetch(url, { ...init, body: JSON.stringify({ ...JSON.parse(init.body), ...intent.extraBody }) })
	}) as typeof fetch
	const context = { ...input.context, config }
	return {
		connectionId: connection.id,
		modelId: model.id,
		request: applyNativeRequestIntent(request, context, intent),
		config: { ...config, fetch: nativeFetch },
		intent,
		fetchAtLevel: undefined,
	}
}
/** Mask headers and credential fields recursively before showing request diagnostics. */
export function redactModelRequest(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(redactModelRequest)
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value)
				.filter(([, v]) => typeof v !== "function")
				.map(([key, v]) => [
					key,
					/headers|secret|token(?!s$)|api.?key|access.?key|authorization|password|credential/i.test(key) &&
					!/^max.*tokens$|^thinkingBudgetTokens$/.test(key)
						? "[REDACTED]"
						: redactModelRequest(v),
				]),
		)
	return value
}
