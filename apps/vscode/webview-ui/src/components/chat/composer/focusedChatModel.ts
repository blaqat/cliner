import { type ApiProvider, type ModelInfo, type OpenAiCompatibleModelInfo, openAiModelInfoSafeDefaults } from "@shared/api"
import type { ApiConfigProfile, OpenAiCompatibleApiType } from "@shared/api-profiles"
import type { ExtensionState } from "@shared/ExtensionMessage"
import { toLegacyApiProvider } from "@shared/model-catalog/provider-helpers"
import type { Mode } from "@shared/storage/types"
import { getModeSpecificFields } from "@/components/settings/utils/providerUtils"

export type FocusedChatState = Pick<
	ExtensionState,
	| "apiConfiguration"
	| "apiConfigProfiles"
	| "askProfileId"
	| "actProfileId"
	| "composerApiSelection"
	| "composerApiConfiguration"
	| "focusedSessionModels"
>

export interface FocusedChatModel {
	provider: ApiProvider
	modelId: string
	/** The saved configuration the chat runs, while it still describes that provider and model. */
	profile?: ApiConfigProfile
	/** User-authored model info (context window, prices): the profile's, else the composer configuration's. */
	customModelInfo?: OpenAiCompatibleModelInfo
	openAiCompatibleApiType?: OpenAiCompatibleApiType
}

/** A profile's model info is captured from one mode and applied to either. */
function profileModelInfo(profile: ApiConfigProfile): OpenAiCompatibleModelInfo | undefined {
	const info = profile.options?.planModeOpenAiModelInfo ?? profile.options?.actModeOpenAiModelInfo
	return info && typeof info === "object" ? (info as OpenAiCompatibleModelInfo) : undefined
}

/**
 * The model the focused chat runs in `mode`. A live session's build wins (it keeps running that
 * model until a picked change applies); otherwise the chat's own selection, which may override the
 * Settings default with another saved configuration. `fallback` is the composer configuration's
 * provider/model, for chats with no saved configuration.
 */
export function resolveFocusedChatModel(
	mode: Mode,
	state: FocusedChatState,
	fallback: { provider: ApiProvider; modelId?: string },
): FocusedChatModel {
	const live = state.focusedSessionModels?.[mode]
	const selection = state.composerApiSelection ?? { askProfileId: state.askProfileId, actProfileId: state.actProfileId }
	const profileId = live ? live.profileId : mode === "plan" ? selection.askProfileId : selection.actProfileId
	const assigned = profileId ? state.apiConfigProfiles?.find((profile) => profile.id === profileId) : undefined
	const provider = toLegacyApiProvider(live?.provider ?? assigned?.provider ?? fallback.provider) as ApiProvider
	const modelId = live?.modelId ?? assigned?.modelId ?? fallback.modelId ?? ""
	// A profile edited since the session was built no longer describes what it runs.
	const profile = assigned && assigned.provider === provider && assigned.modelId === modelId ? assigned : undefined
	const configuration = state.composerApiConfiguration ?? state.apiConfiguration
	if (profile) {
		return {
			provider,
			modelId,
			profile,
			customModelInfo: profileModelInfo(profile),
			openAiCompatibleApiType: profile.openAiCompatibleApiType,
		}
	}
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
