import { createGateway, getProviderCollectionSync, hasRegisteredHandler, type ProviderConfig } from "@cline/llms"
import { ModelCapabilitySchema, ModelInfoSchema } from "@cline/shared"
import type { ModelLevel, ModelPick, ModelSettings } from "@shared/model-settings"
import type { StateManager } from "@/core/storage/StateManager"
import { assertConfiguredModelRequestAllowed, resolveEffectiveConfiguredPick } from "./host-settings"
import { fetch } from "@/shared/net"
import { resolveConfiguredPick } from "../model-settings-resolver"
import { type ConnectionAuthDependencies, prepareModelRequest } from "./request-adapter"

export const requestPolicyGuard = Symbol("requestPolicyGuard")

/** Resolve a configured row without invoking any provider-wide selection or persistence APIs. */
export async function configuredProviderConfig(
	settings: ModelSettings,
	pick: ModelPick | null,
	dependencies: ConnectionAuthDependencies,
	policy?: { state: StateManager; mode?: "act" | "plan" },
): Promise<ProviderConfig & { settingsModelLevels: ModelLevel[]; [requestPolicyGuard]?: () => Promise<void> }> {
	const resolved = policy ? resolveEffectiveConfiguredPick(policy.state, settings, pick) : resolveConfiguredPick(settings, pick)
	if (policy && pick) await assertConfiguredModelRequestAllowed(policy.state, settings, pick, policy.mode)
	const projection = JSON.stringify(resolved)
	const guard =
		policy && pick
			? async () => {
					const current = policy.state.getGlobalStateKey("modelSettings")!
					await assertConfiguredModelRequestAllowed(policy.state, current, pick, policy.mode)
					const effective = resolveEffectiveConfiguredPick(policy.state, current, pick)
					if (JSON.stringify(effective) !== projection)
						throw new Error(
							"Model settings changed. Retry the request to rebuild its configuration. Open Settings > Models.",
						)
				}
			: undefined
	const providerId =
		resolved.connection.kind === "provider"
			? resolved.connection.providerId
			: resolved.connection.apiFormat === "responses"
				? "openai-native"
				: "openai-compatible"
	const gateway = createGateway()
	const gatewayProvider = gateway.listProviders().find((p) => p.id === providerId)
	// Host handlers are registered in the SDK compatibility registry rather
	// than the gateway's builtins. They still need configured admission.
	const hostProvider = hasRegisteredHandler(providerId) ? getProviderCollectionSync(providerId)?.provider : undefined
	const provider =
		gatewayProvider ??
		(hostProvider
			? {
					id: providerId,
					name: hostProvider.name,
					defaultModelId: hostProvider.defaultModelId,
					models: [],
				}
			: undefined)
	if (!provider) throw new Error(`Provider '${providerId}' is unavailable. Open Settings > Models.`)
	const model = (gatewayProvider
		? gateway.listModels(providerId).find((m) => m.id === resolved.model.upstreamId)
		: undefined) ?? {
		id: resolved.model.upstreamId,
		providerId,
		name: resolved.model.name,
		capabilities: [],
	}
	const prepared = await prepareModelRequest(
		{
			...resolved,
			requestTimeoutMs: settings.requestTimeoutMs,
			request: { providerId, modelId: model.id, messages: [] },
			context: { provider, model, config: { providerId } },
			fetch: guard
				? ((async (url, init) => {
						await guard()
						return fetch(url, init)
					}) as typeof fetch)
				: fetch,
		},
		dependencies,
	)
	const options = prepared.config.options ?? {}
	// Ollama's native routing rule consumes the resolved model context, not
	// config.options.num_ctx. The explicit provider field wins over defaults.
	const contextWindow =
		providerId === "ollama"
			? typeof options.num_ctx === "number"
				? options.num_ctx
				: (resolved.values.maxInputTokens ?? resolved.values.contextWindow)
			: resolved.values.contextWindow
	// The host's VS Code LM handler consumes a positional, URI-encoded selector
	// through modelId. Preserve empty positions, including an id without version.
	const selector = providerId === "vscode-lm" ? options.selector : undefined
	const modelId =
		selector && typeof selector === "object"
			? ["vendor", "family", "version", "id"]
					.map((key) => encodeURIComponent(String((selector as Record<string, unknown>)[key] ?? "")))
					.join("/")
			: resolved.model.upstreamId
	const savedInfo = ModelInfoSchema.parse({
		...model,
		capabilities: model.capabilities?.flatMap((c) => {
			const parsed = ModelCapabilitySchema.safeParse(c)
			return parsed.success ? [parsed.data] : []
		}),
		...resolved.model.legacyMetadata?.sdk,
		...resolved.model.legacyMetadata?.modelInfo,
		id: resolved.model.upstreamId,
	})
	return {
		[requestPolicyGuard]: guard,
		providerId: prepared.config.providerId,
		settingsRequestIntent: resolved.connection.kind === "provider" ? prepared.intent : undefined,
		settingsModelLevels: resolved.values.levels,
		settingsProviderOptions: prepared.config.options,
		modelId,
		apiKey: prepared.config.apiKey ?? "",
		apiKeyEnv: [],
		baseUrl: prepared.config.baseUrl,
		headers: prepared.config.headers,
		fetch: prepared.config.fetch,
		timeoutMs: prepared.config.timeoutMs,
		reasoningEffort: prepared.request.reasoning?.effort,
		thinking: prepared.request.reasoning?.enabled,
		thinkingBudgetTokens: prepared.request.reasoning?.budgetTokens,
		maxOutputTokens: resolved.values.maxOutputTokens ?? undefined,
		maxInputTokens:
			providerId === "ollama"
				? (contextWindow ?? undefined)
				: (resolved.values.maxInputTokens ?? contextWindow ?? undefined),
		temperature: resolved.values.temperature ?? undefined,
		region: typeof options.region === "string" ? options.region : undefined,
		aws:
			providerId === "bedrock"
				? ({
						region: options.region,
						accessKey: options.accessKeyId,
						secretKey: options.secretAccessKey,
						sessionToken: options.sessionToken,
						authentication: options.authentication,
						profile: options.profile,
						endpoint: options.endpoint,
						customModelBaseId: options.customModelBaseId,
						useCrossRegionInference: options.useCrossRegionInference,
						useGlobalInference: options.useGlobalInference,
						usePromptCache: options.usePromptCache,
					} as ProviderConfig["aws"])
				: undefined,
		azure:
			resolved.connection.kind === "openai-compatible"
				? {
						apiVersion: resolved.connection.azureApiVersion ?? undefined,
						useIdentity: resolved.connection.auth.kind === "azure-identity",
					}
				: undefined,
		knownModels: {
			[modelId]: {
				...savedInfo,
				id: modelId,
				name: savedInfo.name ?? (resolved.model.name || resolved.model.upstreamId),
				contextWindow: contextWindow ?? model.contextWindow ?? 128000,
				pricing: {
					...savedInfo.pricing,
					input: resolved.values.inputPrice ?? undefined,
					output: resolved.values.outputPrice ?? undefined,
					cacheRead: resolved.values.cacheReadPrice ?? undefined,
					cacheWrite: resolved.values.cacheWritePrice ?? undefined,
				},
				maxTokens: resolved.values.maxOutputTokens ?? undefined,
				capabilities: [
					...(savedInfo.capabilities ?? [])
						.flatMap((c) => {
							const parsed = ModelCapabilitySchema.safeParse(c)
							return parsed.success ? [parsed.data] : []
						})
						.filter(
							(c) =>
								!(c === "images" && resolved.values.images !== "unknown") &&
								!(c === "reasoning" && resolved.values.reasoning !== "unknown") &&
								!(c === "tools" && resolved.values.tools !== "unknown") &&
								!(c === "streaming" && resolved.values.streaming !== "unknown") &&
								!(c === "files" && resolved.values.files !== "unknown") &&
								!(c === "prompt-cache" && resolved.values.promptCache !== "unknown"),
						),
					...(resolved.values.images === "yes" ? ["images" as const] : []),
					...(resolved.values.reasoning === "yes" ? ["reasoning" as const] : []),
					...(resolved.values.tools === "yes" ? ["tools" as const] : []),
					...(resolved.values.streaming === "yes" ? ["streaming" as const] : []),
					...(resolved.values.files === "yes" ? ["files" as const] : []),
					...(resolved.values.promptCache === "yes" ? ["prompt-cache" as const] : []),
				],
			},
		},
	}
}
