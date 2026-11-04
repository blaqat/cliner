import { createGateway, type ProviderConfig } from "@cline/llms"
import { ModelCapabilitySchema, ModelInfoSchema } from "@cline/shared"
import type { ModelLevel, ModelPick, ModelSettings } from "@shared/model-settings"
import { fetch } from "@/shared/net"
import { resolveConfiguredPick } from "../model-settings-resolver"
import { type ConnectionAuthDependencies, prepareModelRequest } from "./request-adapter"

/** Resolve a configured row without invoking any provider-wide selection or persistence APIs. */
export async function configuredProviderConfig(
	settings: ModelSettings,
	pick: ModelPick | null,
	dependencies: ConnectionAuthDependencies,
): Promise<ProviderConfig & { settingsModelLevels: ModelLevel[] }> {
	const resolved = resolveConfiguredPick(settings, pick)
	const providerId =
		resolved.connection.kind === "provider"
			? resolved.connection.providerId
			: resolved.connection.apiFormat === "responses"
				? "openai-native"
				: "openai-compatible"
	const gateway = createGateway()
	const provider = gateway.listProviders().find((p) => p.id === providerId)
	if (!provider) throw new Error(`Provider '${providerId}' is unavailable. Open Settings > Models.`)
	const model = gateway.listModels(providerId).find((m) => m.id === resolved.model.upstreamId) ?? {
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
			fetch,
		},
		dependencies,
	)
	const options = prepared.config.options ?? {}
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
		providerId: prepared.config.providerId,
		settingsRequestIntent: resolved.connection.kind === "provider" ? prepared.intent : undefined,
		settingsModelLevels: resolved.values.levels,
		settingsProviderOptions: prepared.config.options,
		modelId: resolved.model.upstreamId,
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
		maxInputTokens: resolved.values.maxInputTokens ?? resolved.values.contextWindow ?? undefined,
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
			[resolved.model.upstreamId]: {
				...savedInfo,
				id: resolved.model.upstreamId,
				name: savedInfo.name ?? (resolved.model.name || resolved.model.upstreamId),
				contextWindow: resolved.values.contextWindow ?? model.contextWindow ?? 128000,
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
