import type { ModelInfo, OpenAiCompatibleModelInfo } from "@shared/api"
import {
	isOpenaiReasoningEffort,
	type Mode,
	OPENAI_REASONING_EFFORT_OPTIONS,
	type OpenaiReasoningEffort,
} from "@shared/storage/types"
import { memo } from "react"
import { getModeSpecificFields, supportsReasoningEffortForModelId } from "@/components/settings/utils/providerUtils"
import { useApiConfigurationHandlers } from "@/components/settings/utils/useApiConfigurationHandlers"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useExtensionState } from "@/context/ExtensionStateContext"

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

const formatEffort = (effort: string) =>
	effort === "none" ? "Provider default" : effort.charAt(0).toUpperCase() + effort.slice(1)

interface ReasoningEffortPickerProps {
	mode: Mode
	/** Selected provider id for `mode`; used by the composer. */
	provider?: string
	modelId: string | undefined
	modelInfo: ModelInfo | undefined
	defaultEffort?: OpenaiReasoningEffort
}

/**
 * Compact effort dropdown for the composer's bottom bar. Persists the same
 * per-mode `*ModeReasoningEffort` field as the settings ReasoningEffortSelector.
 */
const ReasoningEffortPicker = ({ mode, modelId, modelInfo, defaultEffort = "none" }: ReasoningEffortPickerProps) => {
	const { apiConfiguration, askProfileId, actProfileId } = useExtensionState()
	const { handleFieldChange } = useApiConfigurationHandlers()

	if (!modelHasReasoning(modelId, modelInfo)) {
		return null
	}

	const modeFields = getModeSpecificFields(apiConfiguration, mode)
	const storedEffort = modeFields.reasoningEffort
	const profileAssigned = mode === "plan" ? askProfileId : actProfileId
	const selectedEffort = isOpenaiReasoningEffort(storedEffort) ? storedEffort : profileAssigned ? "none" : defaultEffort

	return (
		<Select
			onValueChange={(value) => {
				if (!isOpenaiReasoningEffort(value)) return
				void handleFieldChange(mode === "plan" ? "planModeReasoningEffort" : "actModeReasoningEffort", value).catch(
					(error) => console.error("Failed to update reasoning effort:", error),
				)
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
