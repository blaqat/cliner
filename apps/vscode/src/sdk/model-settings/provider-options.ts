import { getProviderCollectionSync } from "@cline/llms"
import type { Connection, ModelRow } from "@shared/model-settings"

// Legacy option names remain the form contract; this is the one-way adapter to SDK config.
const mappings: Record<string, Record<string, string>> = {
	bedrock: {
		awsRegion: "region",
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
	vertex: { vertexProjectId: "project", vertexRegion: "location" },
	gemini: { geminiBaseUrl: "baseUrl" },
	"claude-code": { claudeCodePath: "path" },
	"qwen-code": { qwenCodeOauthPath: "oauthPath" },
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
	oca: { ocaBaseUrl: "baseUrl", ocaMode: "mode" },
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
	const map = mappings[connection.providerId] ?? {}
	const result: Record<string, unknown> = {}
	for (const [key, value] of Object.entries({ ...values, ...model?.providerOptions })) {
		// awsUseProfile is a legacy selector, normalized to the explicit SDK auth mode.
		if (key === "awsUseProfile" && connection.providerId === "bedrock") {
			if (value === true) result.authentication = "profile"
			continue
		}
		const slot = map[key]
		if (!slot) throw new Error(`Option ${key} does not belong to ${connection.providerId}`)
		result[slot] = value
	}
	if (result.authentication === "credentials") result.authentication = "iam"
	return result
}
