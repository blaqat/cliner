import type { ModelInfo } from "@shared/api"
import {
	isOpenaiReasoningEffort,
	type Mode,
	OPENAI_REASONING_EFFORT_OPTIONS,
	type OpenaiReasoningEffort,
} from "@shared/storage/types"
import { memo } from "react"
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select"
import { cn } from "@/lib/utils"
import {
	CHIP_ITEM_CLASS,
	CHIP_SEPARATOR_CLASS,
	CHIP_TRIGGER_CLASS,
	ChipAction,
	ChipChevron,
	NEXT_MESSAGE_VALUE,
	RESET_CONFIGURATION_VALUE,
} from "./ConfigPicker"
import { formatEffort, formatEffortShort, useEffortSelection } from "./modelSelection"

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
				aria-label={`Reasoning effort: ${formatEffort(effort.selected)}`}
				className={CHIP_TRIGGER_CLASS}
				data-testid="reasoning-effort-picker"
				showIcon={false}
				title={effort.description}>
				<SelectValue>
					<span className="truncate">
						{formatEffortShort(effort.selected)}
						{effort.pending ? " (pending)" : ""}
					</span>
				</SelectValue>
				<ChipChevron />
			</SelectTrigger>
			<SelectContent align="start" className="menu-rise" side="top">
				{OPENAI_REASONING_EFFORT_OPTIONS.map((option) => (
					<SelectItem className={CHIP_ITEM_CLASS} key={option} value={option}>
						{formatEffort(option)}
					</SelectItem>
				))}
				<SelectSeparator className={CHIP_SEPARATOR_CLASS} />
				<SelectItem className={cn(CHIP_ITEM_CLASS, "text-description")} value={RESET_CONFIGURATION_VALUE}>
					<ChipAction icon="discard">Reset to default</ChipAction>
				</SelectItem>
				{effort.hasChat && (
					<SelectItem
						className={cn(CHIP_ITEM_CLASS, "text-description")}
						disabled={effort.busy}
						value={NEXT_MESSAGE_VALUE}>
						<ChipAction icon={effort.nextMessageOnly ? "pinned" : "arrow-right"}>
							{effort.nextMessageOnly ? "Keep for this chat" : "Use next choice for next message only"}
						</ChipAction>
					</SelectItem>
				)}
			</SelectContent>
		</Select>
	)
}

export default memo(ReasoningEffortPicker)
