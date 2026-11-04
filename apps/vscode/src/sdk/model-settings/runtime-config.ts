import { createGateway, type ProviderConfig } from "@cline/llms"
import type { ModelPick, ModelSettings } from "@shared/model-settings"
import { fetch } from "@/shared/net"
import { resolveConfiguredPick } from "../model-settings-resolver"
import { type ConnectionAuthDependencies, prepareModelRequest } from "./request-adapter"

/** Resolve a configured row without invoking any provider-wide selection or persistence APIs. */
export async function configuredProviderConfig(
	settings: ModelSettings,
	pick: ModelPick | null,
	dependencies: ConnectionAuthDependencies,
): Promise<ProviderConfig> {
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
	if (
		resolved.connection.kind === "provider" &&
		(prepared.intent.level.kind === "thinking-level" ||
			prepared.intent.verbosity !== null ||
			prepared.intent.systemRole !== "system")
	)
		throw new Error("This native setting requires request-intent runtime support. Open Settings > Models.")
	const options = prepared.config.options ?? {}
	return {
		providerId: prepared.config.providerId,
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
				id: resolved.model.upstreamId,
				name: resolved.model.name || resolved.model.upstreamId,
				contextWindow: resolved.values.contextWindow ?? 128000,
				maxTokens: resolved.values.maxOutputTokens ?? undefined,
				capabilities: [
					...(resolved.values.images === "yes" ? ["images" as const] : []),
					...(resolved.values.reasoning === "yes" ? ["reasoning" as const] : []),
				],
			},
		},
	}
}
