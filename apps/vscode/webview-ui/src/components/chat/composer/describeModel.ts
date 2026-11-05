import type { OpenAiCompatibleApiType } from "@shared/api-profiles"

export const PROVIDER_LABELS: Record<string, string> = {
	openai: "OpenAI Compatible",
	anthropic: "Anthropic",
	bedrock: "Amazon Bedrock",
	"openai-native": "OpenAI",
}

const API_TYPE_LABELS: Record<OpenAiCompatibleApiType, string> = {
	chat: "Chat Completions",
	responses: "Responses",
}

/** "Anthropic · claude-x", with the API type for OpenAI-compatible models. */
export function describeModel(model: {
	provider: string
	modelId: string
	openAiCompatibleApiType?: OpenAiCompatibleApiType
}): string {
	const parts = [PROVIDER_LABELS[model.provider] ?? model.provider, model.modelId || "no model"]
	if (model.provider === "openai") {
		parts.push(API_TYPE_LABELS[model.openAiCompatibleApiType ?? "chat"])
	}
	return parts.join(" · ")
}
