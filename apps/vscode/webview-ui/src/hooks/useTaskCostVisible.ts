import type { OpenAiCompatibleModelInfo } from "@shared/api"
import { type UsageCostDisplay, useProviderUsageCostDisplay } from "./useProviderUsageCostDisplay"

/**
 * Whether a chat's dollar cost is meaningful for its provider.
 *
 * Local providers report no cost; the openai-compatible provider can
 * report cost only when the user has supplied both prices. For every
 * other provider, the SDK is the source of truth: any
 * `metadata.usageCostDisplay` other than "show" — "hide", or
 * "subscription" for flat-rate providers like ClinePass and ChatGPT
 * Plus/Pro where the computed figure would be an API-rate estimate rather
 * than a real charge — suppresses the cost. This mirrors the CLI's
 * `shouldShowCliUsageCost` consumer.
 */
export function isTaskCostVisible(
	provider: string | undefined,
	customModelInfo: Pick<OpenAiCompatibleModelInfo, "inputPrice" | "outputPrice"> | undefined,
	usageCostDisplay: UsageCostDisplay | "unknown",
	totalCost: number | undefined,
): boolean {
	return Boolean(
		(totalCost && provider === "openai" && customModelInfo?.inputPrice && customModelInfo?.outputPrice) ||
			(provider !== "vscode-lm" && provider !== "ollama" && provider !== "lmstudio" && usageCostDisplay === "show"),
	)
}

/**
 * `isTaskCostVisible` for the model a chat actually runs (see `useFocusedChatModel`), not the
 * Settings default: a chat can override to a configuration with another provider or prices.
 */
export function useTaskCostVisible(
	model: { provider: string | undefined; customModelInfo?: OpenAiCompatibleModelInfo },
	totalCost: number | undefined,
): boolean {
	const usageCostDisplay = useProviderUsageCostDisplay(model.provider)
	return isTaskCostVisible(model.provider, model.customModelInfo, usageCostDisplay, totalCost)
}
