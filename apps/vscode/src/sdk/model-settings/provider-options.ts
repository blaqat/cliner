import { getProviderCollectionSync } from "@cline/llms"
import type { Connection, ModelRow } from "@shared/model-settings"
import type { SecretKey } from "@shared/storage/state-keys"

// Legacy option names remain the form contract; this is the one-way adapter to SDK config.
export const providerOptionMappings: Record<string, Record<string, string>> = {
	bedrock: {
		awsRegion: "region",
		awsUseProfile: "authentication",
		awsAuthentication: "authentication",
		awsProfile: "profile",
		awsBedrockEndpoint: "endpoint",
		awsAccessKey: "accessKeyId",
		awsSecretKey: "secretAccessKey",
		awsSessionToken: "sessionToken",
		awsBedrockApiKey: "bedrockApiKey",
		actModeAwsBedrockCustomSelected: "customSelected",
		actModeAwsBedrockCustomModelBaseId: "customModelBaseId",
		awsUseCrossRegionInference: "useCrossRegionInference",
		awsUseGlobalInference: "useGlobalInference",
		awsBedrockUsePromptCache: "usePromptCache",
	},
	openrouter: { openRouterProviderSorting: "openRouterProviderSorting" },
	litellm: { liteLlmBaseUrl: "baseUrl", liteLlmUsePromptCache: "usePromptCache" },
	requesty: { requestyBaseUrl: "baseUrl" },
	vertex: { vertexProjectId: "project", vertexRegion: "location" },
	gemini: { geminiBaseUrl: "baseUrl" },
	"claude-code": { claudeCodePath: "path" },
	"qwen-code": { qwenCodeOauthPath: "oauthPath", qwenApiLine: "apiLine" },
	qwen: { qwenApiLine: "apiLine" },
	moonshot: { moonshotApiLine: "apiLine" },
	asksage: { tasksageApiUrl: "baseUrl" },
	sapaicore: {
		sapAiResourceGroup: "resourceGroup",
		sapAiCoreTokenUrl: "tokenUrl",
		sapAiCoreBaseUrl: "baseUrl",
		sapAiCoreUseOrchestrationMode: "useOrchestrationMode",
		actModeSapAiCoreDeploymentId: "deploymentId",
		sapAiCoreClientId: "clientId",
		sapAiCoreClientSecret: "clientSecret",
	},
	dify: { difyBaseUrl: "baseUrl" },
	zai: { zaiApiLine: "apiLine" },
	"zai-coding-plan": { zaiApiLine: "apiLine" },
	oca: { ocaBaseUrl: "baseUrl", ocaMode: "mode", ocaUsePromptCache: "usePromptCache" },
	minimax: { minimaxApiLine: "apiLine" },
	aihubmix: { aihubmixBaseUrl: "baseUrl", aihubmixAppCode: "appCode" },
	ollama: { ollamaApiOptionsCtxNum: "num_ctx" },
	lmstudio: { lmStudioMaxTokens: "maxTokens" },
	fireworks: { fireworksModelMaxCompletionTokens: "maxCompletionTokens", fireworksModelMaxTokens: "maxTokens" },
	"vscode-lm": { actModeVsCodeLmModelSelector: "selector" },
}
export function connectionProviderOptions(
	connection: Connection,
	values: Record<string, unknown>,
	model?: ModelRow,
): Record<string, unknown> {
	if (connection.kind !== "provider") return values
	const manifest = getProviderCollectionSync(connection.providerId)?.provider
	if (!manifest) throw new Error(`Unknown SDK provider ${connection.providerId}`)
	const map = providerOptionMappings[connection.providerId] ?? {}
	const result: Record<string, unknown> = {}
	for (const [key, value] of Object.entries({ ...values, ...model?.providerOptions })) {
		// awsUseProfile is a legacy selector, normalized to the explicit SDK auth mode.
		if (key === "awsUseProfile" && connection.providerId === "bedrock") {
			if (value === true) result.authentication = "profile"
			continue
		}
		const slot = map[key]
		if (!slot) throw new Error(`Option ${key} does not belong to ${connection.providerId}`)
		if (connection.providerId === "ollama" && slot === "num_ctx") {
			if (typeof value === "string" && value.trim() === "") continue
			const numCtx = Number(value)
			if (!Number.isSafeInteger(numCtx) || numCtx <= 0) throw new Error("Ollama context must be a positive integer")
			result[slot] = numCtx
			continue
		}
		result[slot] = value
	}
	if (result.authentication === "credentials") result.authentication = "iam"
	return result
}

// Spelled out, not derived: "openrouter" is stored as openRouterApiKey, and the type checks every name.
const PROVIDER_SECRET_FIELDS: Record<string, readonly SecretKey[]> = {
	aihubmix: ["aihubmixApiKey"],
	anthropic: ["apiKey"],
	asksage: ["asksageApiKey"],
	baseten: ["basetenApiKey"],
	bedrock: ["awsAccessKey", "awsSecretKey", "awsSessionToken", "awsBedrockApiKey"],
	cerebras: ["cerebrasApiKey"],
	cline: ["clineApiKey"],
	deepseek: ["deepSeekApiKey"],
	dify: ["difyApiKey"],
	doubao: ["doubaoApiKey"],
	fireworks: ["fireworksApiKey"],
	gemini: ["geminiApiKey"],
	groq: ["groqApiKey"],
	hicap: ["hicapApiKey"],
	"huawei-cloud-maas": ["huaweiCloudMaasApiKey"],
	huggingface: ["huggingFaceApiKey"],
	litellm: ["liteLlmApiKey"],
	minimax: ["minimaxApiKey"],
	mistral: ["mistralApiKey"],
	moonshot: ["moonshotApiKey"],
	nebius: ["nebiusApiKey"],
	nousResearch: ["nousResearchApiKey"],
	oca: ["ocaApiKey"],
	ollama: ["ollamaApiKey"],
	openai: ["openAiApiKey"],
	"openai-compatible": ["openAiApiKey"],
	"openai-native": ["openAiNativeApiKey"],
	openrouter: ["openRouterApiKey"],
	qwen: ["qwenApiKey"],
	requesty: ["requestyApiKey"],
	sambanova: ["sambanovaApiKey"],
	sapaicore: ["sapAiCoreClientId", "sapAiCoreClientSecret"],
	together: ["togetherApiKey"],
	"vercel-ai-gateway": ["vercelAiGatewayApiKey"],
	wandb: ["wandbApiKey"],
	xai: ["xaiApiKey"],
	zai: ["zaiApiKey"],
	"zai-coding-plan": ["zaiApiKey"],
}

export function providerSecretFields(provider: string): string[] {
	return [...(PROVIDER_SECRET_FIELDS[provider] ?? [])]
}
