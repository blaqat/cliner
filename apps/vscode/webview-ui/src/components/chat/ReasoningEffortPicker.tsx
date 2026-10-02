import type { ModelInfo, OpenAiCompatibleModelInfo } from "@shared/api"
import { AssignApiProfileRequest } from "@shared/proto/cline/models"
import {
	isOpenaiReasoningEffort,
	type Mode,
	OPENAI_REASONING_EFFORT_OPTIONS,
	type OpenaiReasoningEffort,
} from "@shared/storage/types"
import { memo } from "react"
import { getModeSpecificFields, supportsReasoningEffortForModelId } from "@/components/settings/utils/providerUtils"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { ModelsServiceClient } from "@/services/grpc-client"
import { NEXT_MESSAGE_VALUE, RESET_CONFIGURATION_VALUE } from "./ConfigPicker"

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
 * Compact effort dropdown for the composer's bottom bar. Updates the chat selection without touching Settings.
 */
const ReasoningEffortPicker = ({ mode, modelId, modelInfo, defaultEffort = "none" }: ReasoningEffortPickerProps) => {
	const {
		apiConfiguration,
		askProfileId,
		actProfileId,
		composerApiSelection,
		composerNextMessageOnly,
		currentTaskItem,
		turnState,
		focusedSessionModels,
	} = useExtensionState()
	const busy = turnState?.phase === "streaming" || turnState?.phase === "awaiting_approval"
	const update = (changes: Partial<Parameters<typeof AssignApiProfileRequest.create>[0]>) =>
		void ModelsServiceClient.assignApiProfile(
			AssignApiProfileRequest.create({ mode, chatOverride: true, taskId: currentTaskItem?.id ?? "", ...changes }),
		).catch((error) => console.error("Failed to update chat effort:", error))

	if (!modelHasReasoning(modelId, modelInfo)) {
		return null
	}

	const modeFields = getModeSpecificFields(apiConfiguration, mode)
	const storedEffort = composerApiSelection ? composerApiSelection[`${mode}ModeReasoningEffort`] : modeFields.reasoningEffort
	const profileAssigned =
		mode === "plan"
			? (composerApiSelection?.askProfileId ?? askProfileId)
			: (composerApiSelection?.actProfileId ?? actProfileId)
	const selectedEffort = isOpenaiReasoningEffort(storedEffort) ? storedEffort : profileAssigned ? "none" : defaultEffort

	const effective = focusedSessionModels?.[mode]
	const pending = !!effective && (effective.reasoningEffort ?? "none") !== selectedEffort

	return (
		<Select
			disabled={!!composerNextMessageOnly && busy}
			onValueChange={(value) => {
				if (value === RESET_CONFIGURATION_VALUE) update({ resetToDefault: true })
				else if (value === NEXT_MESSAGE_VALUE) update({ nextMessageOnly: !composerNextMessageOnly })
				else if (isOpenaiReasoningEffort(value)) update({ reasoningEffort: value })
			}}
			value={selectedEffort}>
			<SelectTrigger
				aria-label="Reasoning effort"
				className="h-5 shrink-0 gap-0.5 rounded-xs border-0 bg-transparent px-1 py-0 text-xs text-description shadow-none hover:text-foreground focus-visible:ring-0 data-[size=default]:h-5 [&_svg]:size-2.5"
				data-testid="reasoning-effort-picker"
				title={
					pending
						? `Currently uses ${formatEffort(effective?.reasoningEffort ?? "none")}; change pending`
						: "Reasoning effort"
				}>
				<SelectValue>
					{formatEffort(selectedEffort)}
					{pending ? " (pending)" : ""}
				</SelectValue>
			</SelectTrigger>
			<SelectContent align="start" className="menu-rise" side="top">
				{OPENAI_REASONING_EFFORT_OPTIONS.map((effort) => (
					<SelectItem className="text-xs" key={effort} value={effort}>
						{formatEffort(effort)}
					</SelectItem>
				))}
				<SelectItem className="text-xs text-description" value={RESET_CONFIGURATION_VALUE}>
					Reset to default
				</SelectItem>
				{currentTaskItem && (
					<SelectItem className="text-xs text-description" disabled={busy} value={NEXT_MESSAGE_VALUE}>
						{composerNextMessageOnly ? "Keep for this chat" : "Use next choice for next message only"}
					</SelectItem>
				)}
			</SelectContent>
		</Select>
	)
}

export default memo(ReasoningEffortPicker)
