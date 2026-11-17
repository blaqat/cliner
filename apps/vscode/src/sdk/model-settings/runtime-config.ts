import {
	createGateway,
	getProviderCollectionSync,
	hasRegisteredHandler,
	type LevelRequest,
	type ProviderConfig,
} from "@cline/llms"
import { type ModelCapability, ModelCapabilitySchema, ModelInfoSchema } from "@cline/shared"
import type { ModelLevel, ModelPick, ModelSettings } from "@shared/model-settings"
import type { StateManager } from "@/core/storage/StateManager"
import { fetch } from "@/shared/net"
import { resolveConfiguredPick } from "../model-settings-resolver"
import { assertConfiguredModelRequestAllowed, resolveEffectiveConfiguredPick } from "./host-settings"
import { type ConnectionAuthDependencies, prepareModelRequest } from "./request-adapter"

export const requestPolicyGuard = Symbol("requestPolicyGuard")

/** Resolve a configured row without invoking any provider-wide selection or persistence APIs. */
export async function configuredProviderConfig(
	settings: ModelSettings,
	pick: ModelPick | null,
	dependencies: ConnectionAuthDependencies,
	policy?: { state: StateManager; mode?: "act" | "plan" },
): Promise<
	ProviderConfig & {
		settingsModelLevels: ModelLevel[]
		settingsFetchAtLevel?: (level: LevelRequest) => typeof fetch
		[requestPolicyGuard]?: () => Promise<void>
	}
> {
	const resolved = policy ? resolveEffectiveConfiguredPick(policy.state, settings, pick) : resolveConfiguredPick(settings, pick)
	if (policy && pick) await assertConfiguredModelRequestAllowed(policy.state, settings, pick, policy.mode)
	const built = policy && pick ? structuredClone(settings) : settings
	// Detection only suggests values for the form, so finding new ones mid-turn isn't the organization changing them.
	const policyView = () => JSON.stringify(resolveEffectiveConfiguredPick(policy!.state, built, pick, false))
	const projection = policy && pick ? policyView() : undefined
	// A user edit reaches this session through its scheduled rebuild, so a running
	// turn finishes on what it started with. Refuse only what must stop now: the
	// row is gone or locked, or the organization changed this build's own values.
	const guard =
		policy && pick
			? async () => {
					const current = policy.state.getGlobalStateKey("modelSettings")!
					await assertConfiguredModelRequestAllowed(policy.state, current, pick, policy.mode)
					if (policyView() !== projection)
						throw new Error(
							"Your organization changed this model's settings. Send your message again to use them, or open Settings > Models.",
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
	const catalogModel = (gatewayProvider
		? gateway.listModels(providerId).find((m) => m.id === resolved.model.upstreamId)
		: undefined) ?? {
		id: resolved.model.upstreamId,
		providerId,
		name: resolved.model.name,
		capabilities: [],
	}
	// The row's own answer outranks the catalog; deployments and ARNs are never listed.
	const model = {
		...catalogModel,
		capabilities:
			resolved.values.reasoning === "unknown"
				? catalogModel.capabilities
				: [
						...(catalogModel.capabilities ?? []).filter((c) => c !== "reasoning"),
						...(resolved.values.reasoning === "yes" ? ["reasoning" as const] : []),
					],
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
	// A saved Bedrock API key sits with its other credentials, but the provider only reads one from apiKey here:
	// empty is what it takes as "no key", and it then asks for SigV4 instead.
	const bedrockApiKey =
		providerId === "bedrock" && ["apikey", "api-key"].includes(String(options.authentication))
			? (options.bedrockApiKey as string | undefined)
			: undefined
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
	const capabilities: ModelCapability[] = [
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
	]
	// The SDK reads a populated list as authoritative, and an empty one as "unspecified", which is a yes.
	// Tools and images are off unless the catalog knows the model or the person said yes.
	if (!capabilities.length) capabilities.push("text")
	return {
		[requestPolicyGuard]: guard,
		// Responses on a compatible connection only borrows OpenAI's adapter. Staying this provider keeps
		// OpenAI's own built-in tools (image generation, web search) off servers that refuse them.
		...(resolved.connection.kind === "openai-compatible"
			? { providerId: "openai-compatible", routingProviderId: prepared.config.providerId }
			: { providerId: prepared.config.providerId }),
		settingsRequestIntent: resolved.connection.kind === "provider" ? prepared.intent : undefined,
		settingsModelLevels: resolved.values.levels,
		settingsFetchAtLevel: prepared.fetchAtLevel,
		settingsProviderOptions: prepared.config.options,
		modelId,
		apiKey: prepared.config.apiKey || bedrockApiKey || "",
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
				// The 128K planning default is for compatible servers, whose body carries no
				// synthesized limit. On a native route it would raise the output cap sent for
				// an unlisted model past what that model accepts.
				contextWindow:
					contextWindow ?? model.contextWindow ?? (resolved.connection.kind === "provider" ? undefined : 128000),
				pricing: {
					...savedInfo.pricing,
					input: resolved.values.inputPrice ?? undefined,
					output: resolved.values.outputPrice ?? undefined,
					cacheRead: resolved.values.cacheReadPrice ?? undefined,
					cacheWrite: resolved.values.cacheWritePrice ?? undefined,
				},
				maxTokens: resolved.values.maxOutputTokens ?? model.maxOutputTokens ?? savedInfo.maxTokens,
				capabilities,
			},
		},
	}
}
