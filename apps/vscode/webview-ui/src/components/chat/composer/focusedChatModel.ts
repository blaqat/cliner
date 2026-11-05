import { type ApiProvider, type ModelInfo, type OpenAiCompatibleModelInfo, openAiModelInfoSafeDefaults } from "@shared/api"
import type { OpenAiCompatibleApiType } from "@shared/api-profiles"
import type { ExtensionState } from "@shared/ExtensionMessage"
import { toLegacyApiProvider } from "@shared/model-catalog/provider-helpers"
import type { Mode } from "@shared/storage/types"
import { getModeSpecificFields } from "@/components/settings/utils/providerUtils"
import { selectedConfiguredModel } from "./selectedConfiguredModel"

export type FocusedChatState = Pick<
	ExtensionState,
	"apiConfiguration" | "composerApiSelection" | "composerApiConfiguration" | "focusedSessionModels" | "modelSettings"
>

export interface FocusedChatModel {
	provider: ApiProvider
	modelId: string
	/** User-authored model info (context window, prices). */
	customModelInfo?: OpenAiCompatibleModelInfo
	openAiCompatibleApiType?: OpenAiCompatibleApiType
}

/**
 * The model the focused chat runs in `mode`. A live session's build wins (it keeps running that
 * model until a picked change applies); otherwise the chat's own selection. Without the store, what's
 * running is the old runtime's last selection: `fallback`, the composer configuration's provider/model.
 */
export function resolveFocusedChatModel(
	mode: Mode,
	state: FocusedChatState,
	fallback: { provider: ApiProvider; modelId?: string },
): FocusedChatModel {
	const live = state.focusedSessionModels?.[mode]
	if (state.modelSettings) {
		const configured = selectedConfiguredModel(state, mode)
		const compatible = configured?.connection.kind === "openai-compatible" ? configured.connection : undefined
		const provider = toLegacyApiProvider(live?.provider ?? configured?.provider ?? "openai") as ApiProvider
		const modelId = live?.modelId ?? configured?.model.upstreamId ?? ""
		const values = configured?.model.upstreamId === modelId ? configured.effective : undefined
		return {
			provider,
			modelId,
			customModelInfo: values && {
				...openAiModelInfoSafeDefaults,
				contextWindow: values.contextWindow.value ?? openAiModelInfoSafeDefaults.contextWindow,
				inputPrice: values.inputPrice.value ?? 0,
				outputPrice: values.outputPrice.value ?? 0,
			},
			openAiCompatibleApiType: compatible?.apiFormat,
		}
	}
	const provider = toLegacyApiProvider(live?.provider ?? fallback.provider) as ApiProvider
	const modelId = live?.modelId ?? fallback.modelId ?? ""
	const configuration = state.composerApiConfiguration ?? state.apiConfiguration
	const matchesConfiguration = provider === fallback.provider && modelId === (fallback.modelId ?? "")
	return {
		provider,
		modelId,
		customModelInfo: matchesConfiguration ? getModeSpecificFields(configuration, mode).openAiModelInfo : undefined,
		openAiCompatibleApiType: matchesConfiguration ? configuration?.openAiCompatibleApiType : undefined,
	}
}

/**
 * The context window the session runs with. Mirrors the host: a user-authored window overrides the
 * catalog unless it is still the safe default, which only stands in when the catalog has nothing.
 */
export function effectiveContextWindow(
	customModelInfo: Pick<ModelInfo, "contextWindow"> | undefined,
	catalogModelInfo: Pick<ModelInfo, "contextWindow"> | undefined,
): number | undefined {
	const custom = customModelInfo?.contextWindow
	if (custom && custom !== openAiModelInfoSafeDefaults.contextWindow) {
		return custom
	}
	return catalogModelInfo?.contextWindow || custom || undefined
}
