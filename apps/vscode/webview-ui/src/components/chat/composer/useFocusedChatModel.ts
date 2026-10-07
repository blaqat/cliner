import type { Mode } from "@shared/storage/types"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { getActiveProviderAndModelId, useResolvedModelInfo } from "@/hooks/useNormalizedApiConfiguration"
import { effectiveContextWindow, type FocusedChatModel, resolveFocusedChatModel } from "./focusedChatModel"

/** The focused chat's effective model in `mode`, with the context window it runs with. */
export function useFocusedChatModel(mode: Mode): FocusedChatModel & { contextWindow?: number } {
	const state = useExtensionState()
	const fallback = getActiveProviderAndModelId(state.composerApiConfiguration ?? state.apiConfiguration, mode)
	const model = resolveFocusedChatModel(mode, state, fallback)
	const { selectedModelInfo } = useResolvedModelInfo(model.provider, model.modelId)
	return { ...model, contextWindow: effectiveContextWindow(model.customModelInfo, selectedModelInfo) }
}
