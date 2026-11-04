import { applyCompatibleRequestIntent, applyNativeRequestIntent, type ModelRequestIntent } from "@cline/llms"
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

export interface ConnectionAuthDependencies {
	secrets: ConnectionSecretStore
	environment: Readonly<Record<string, string | undefined>>
	sdkAccount?: (providerId: string) => Promise<GatewayResolvedProviderConfig>
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
			if (!deps.azureIdentity) throw new Error("Azure identity resolver is unavailable")
			apiKey = await deps.azureIdentity()
			if (!apiKey.trim()) throw new Error("Azure identity token is empty")
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
	if (connection.auth.kind === "azure-identity") headers.Authorization = `Bearer ${apiKey}`
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
export async function prepareModelRequest(
	input: {
		connection: Connection
		model: ModelRow
		values: ModelValues
		levelId: string
		request: GatewayStreamRequest
		context: GatewayProviderContext
		requestTimeoutMs: number | null
		fetch?: typeof fetch
	},
	deps: ConnectionAuthDependencies,
) {
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
	const baseFetch: typeof fetch = (async (url, init) => {
		if (config.timeoutMs === undefined) return transportFetch(url, init)
		const timeout = AbortSignal.timeout(config.timeoutMs)
		return transportFetch(url, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout })
	}) as typeof fetch
	if (connection.kind === "openai-compatible") {
		// The final vendor body is the single assembly used for sending and preview.
		applyCompatibleRequestIntent({}, format!, intent, input.context)
		config.providerId = format === "responses" ? "openai-native" : "openai-compatible"
		request.providerId = config.providerId
		config.fetch = (async (url, init) => {
			if (typeof init?.body !== "string") throw new Error("Expected a serialized compatible request")
			const body = applyCompatibleRequestIntent(JSON.parse(init.body), format!, intent, input.context)
			const headers = new Headers(init.headers)
			if (connection.auth.kind === "none") {
				headers.delete("authorization")
				headers.delete("api-key")
			}
			return baseFetch(url, { ...init, headers, body: JSON.stringify(body) })
		}) as typeof fetch
		return { connectionId: connection.id, modelId: model.id, request, config, intent }
	}
	const nativeFetch = (async (url, init) => {
		if (
			connection.auth.kind === "none" &&
			!(
				connection.kind === "provider" &&
				["bedrock", "vertex", "claude-code", "qwen-code", "openai-codex", "opencode"].includes(connection.providerId)
			)
		) {
			const headers = new Headers(init?.headers)
			headers.delete("authorization")
			headers.delete("api-key")
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
