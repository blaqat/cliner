import type { ModelInfo, OpenAiCompatibleModelInfo } from "@shared/api"
import { ProviderReasoningPatch, WriteProviderConfigPatch, WriteProviderConfigRequest } from "@shared/proto/cline/models"
import {
	isOpenaiReasoningEffort,
	type Mode,
	OPENAI_REASONING_EFFORT_OPTIONS,
	type OpenaiReasoningEffort,
} from "@shared/storage/types"
import { isClaudeOpusAdaptiveThinkingModel, resolveClaudeOpusAdaptiveThinking } from "@shared/utils/reasoning-support"
import { memo } from "react"
import { getModeSpecificFields, supportsReasoningEffortForModelId } from "@/components/settings/utils/providerUtils"
import { useApiConfigurationHandlers } from "@/components/settings/utils/useApiConfigurationHandlers"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { ModelsServiceClient } from "@/services/grpc-client"

/** True when the selected model exposes any reasoning control the effort picker can drive. */
export function modelHasReasoning(modelId: string | undefined, modelInfo: ModelInfo | undefined): boolean {
	if (!modelInfo && !modelId) {
		return false
	}
	return (
		modelInfo?.supportsReasoning === true ||
		(modelInfo as OpenAiCompatibleModelInfo | undefined)?.supportsReasoningEffort === true ||
		modelInfo?.capabilities?.includes("reasoning") === true ||
		supportsReasoningEffortForModelId(modelId)
	)
}

/**
 * Providers whose settings UI also writes effort into the provider config
 * (AnthropicProvider / OpenAICompatible `write({ reasoning })`). The bottom-bar
 * picker mirrors that so both surfaces have the same effect. Undefined for
 * providers that only use the per-mode `*ModeReasoningEffort` field.
 */
export function providerReasoningPatch(
	provider: string | undefined,
	effort: OpenaiReasoningEffort,
): ProviderReasoningPatch | undefined {
	switch (provider) {
		case "anthropic":
			return ProviderReasoningPatch.create({ enabled: effort !== "none", effort })
		case "openai":
			return ProviderReasoningPatch.create({ enabled: effort !== "none", effort: effort !== "none" ? effort : undefined })
		default:
			return undefined
	}
}

const formatEffort = (effort: string) => effort.charAt(0).toUpperCase() + effort.slice(1)

interface ReasoningEffortPickerProps {
	mode: Mode
	/** Selected provider id for `mode`; drives the provider-config write. */
	provider?: string
	modelId: string | undefined
	modelInfo: ModelInfo | undefined
	defaultEffort?: OpenaiReasoningEffort
}

/**
 * Compact effort dropdown for the composer's bottom bar. Persists the same
 * per-mode `*ModeReasoningEffort` field as the settings ReasoningEffortSelector.
 */
const ReasoningEffortPicker = ({ mode, provider, modelId, modelInfo, defaultEffort = "medium" }: ReasoningEffortPickerProps) => {
	const { apiConfiguration } = useExtensionState()
	const { handleModeFieldChange } = useApiConfigurationHandlers()

	if (!modelHasReasoning(modelId, modelInfo)) {
		return null
	}

	const modeFields = getModeSpecificFields(apiConfiguration, mode)
	const storedEffort = modeFields.reasoningEffort
	// Same fallback as the Anthropic settings selector (legacy thinking budget => high).
	const fallbackEffort =
		provider === "anthropic" && isClaudeOpusAdaptiveThinkingModel(modelId)
			? (resolveClaudeOpusAdaptiveThinking(storedEffort, modeFields.thinkingBudgetTokens).effort ?? "none")
			: defaultEffort
	const selectedEffort = isOpenaiReasoningEffort(storedEffort) ? storedEffort : fallbackEffort

	return (
		<Select
			onValueChange={(value) => {
				void handleModeFieldChange({ plan: "planModeReasoningEffort", act: "actModeReasoningEffort" }, value, mode).catch(
					(error) => console.error("Failed to update reasoning effort:", error),
				)
				const reasoning = isOpenaiReasoningEffort(value) ? providerReasoningPatch(provider, value) : undefined
				if (provider && reasoning) {
					void ModelsServiceClient.writeProviderConfig(
						WriteProviderConfigRequest.create({
							providerId: provider,
							patch: WriteProviderConfigPatch.create({ reasoning }),
						}),
					).catch((error) => console.error("Failed to update provider reasoning effort:", error))
				}
			}}
			value={selectedEffort}>
			<SelectTrigger
				aria-label="Reasoning effort"
				className="h-5 shrink-0 gap-0.5 rounded-xs border-0 bg-transparent px-1 py-0 text-xs text-description shadow-none hover:text-foreground focus-visible:ring-0 data-[size=default]:h-5 [&_svg]:size-2.5"
				data-testid="reasoning-effort-picker"
				title="Reasoning effort">
				<SelectValue />
			</SelectTrigger>
			<SelectContent align="start" className="menu-rise" side="top">
				{OPENAI_REASONING_EFFORT_OPTIONS.map((effort) => (
					<SelectItem className="text-xs" key={effort} value={effort}>
						{formatEffort(effort)}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	)
}

export default memo(ReasoningEffortPicker)
