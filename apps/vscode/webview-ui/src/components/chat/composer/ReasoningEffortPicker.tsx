import type { ModelInfo } from "@shared/api"
import {
	isOpenaiReasoningEffort,
	type Mode,
	OPENAI_REASONING_EFFORT_OPTIONS,
	type OpenaiReasoningEffort,
} from "@shared/storage/types"
import { memo } from "react"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { NEXT_MESSAGE_VALUE, RESET_CONFIGURATION_VALUE } from "./ConfigPicker"
import { formatEffort, useEffortSelection } from "./modelSelection"

interface ReasoningEffortPickerProps {
	mode: Mode
	modelId: string | undefined
	modelInfo: ModelInfo | undefined
	defaultEffort?: OpenaiReasoningEffort
}

/**
 * Compact effort dropdown for the composer's bottom bar. Updates the chat selection without touching Settings.
 */
const ReasoningEffortPicker = ({ mode, modelId, modelInfo, defaultEffort = "none" }: ReasoningEffortPickerProps) => {
	const effort = useEffortSelection(mode, { modelId, modelInfo, defaultEffort })

	if (!effort.available) {
		return null
	}

	return (
		<Select
			disabled={effort.locked}
			onValueChange={(value) => {
				if (value === RESET_CONFIGURATION_VALUE) effort.reset()
				else if (value === NEXT_MESSAGE_VALUE) effort.toggleNextMessageOnly()
				else if (isOpenaiReasoningEffort(value)) effort.select(value)
			}}
			value={effort.selected}>
			<SelectTrigger
				aria-label="Reasoning effort"
				className="h-5 min-w-0 shrink gap-0.5 rounded-xs border-0 bg-transparent px-1 py-0 text-xs text-description shadow-none hover:text-foreground focus-visible:ring-0 data-[size=default]:h-5 [&_svg]:size-2.5"
				data-testid="reasoning-effort-picker"
				title={effort.description}>
				<SelectValue>
					<span className="truncate">
						{formatEffort(effort.selected)}
						{effort.pending ? " (pending)" : ""}
					</span>
				</SelectValue>
			</SelectTrigger>
			<SelectContent align="start" className="menu-rise" side="top">
				{OPENAI_REASONING_EFFORT_OPTIONS.map((option) => (
					<SelectItem className="text-xs" key={option} value={option}>
						{formatEffort(option)}
					</SelectItem>
				))}
				<SelectItem className="text-xs text-description" value={RESET_CONFIGURATION_VALUE}>
					Reset to default
				</SelectItem>
				{effort.hasChat && (
					<SelectItem className="text-xs text-description" disabled={effort.busy} value={NEXT_MESSAGE_VALUE}>
						{effort.nextMessageOnly ? "Keep for this chat" : "Use next choice for next message only"}
					</SelectItem>
				)}
			</SelectContent>
		</Select>
	)
}

export default memo(ReasoningEffortPicker)
