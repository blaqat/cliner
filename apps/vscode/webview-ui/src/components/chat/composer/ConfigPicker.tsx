import type { Mode } from "@shared/storage/types"
import { memo } from "react"
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useConfigSelection } from "./modelSelection"

/** Sentinel value for the "Manage configurations…" entry; never assigned. */
export const MANAGE_CONFIGURATIONS_VALUE = "__manage_configurations__"
export const RESET_CONFIGURATION_VALUE = "__reset_configuration__"
export const NEXT_MESSAGE_VALUE = "__next_message__"

interface ConfigPickerProps {
	mode: Mode
	/** Shown when no saved configuration is assigned (e.g. before any exist). */
	fallbackLabel: string
}

/**
 * Bottom-bar picker listing saved configuration names for the current mode.
 * Picking one overrides this chat or the next-chat draft; "Manage configurations…" opens the API
 * settings tab.
 */
const ConfigPicker = ({ mode, fallbackLabel }: ConfigPickerProps) => {
	const config = useConfigSelection(mode, fallbackLabel)

	return (
		<Select
			disabled={config.locked}
			onValueChange={(value) => {
				if (value === MANAGE_CONFIGURATIONS_VALUE) config.manage()
				else if (value === RESET_CONFIGURATION_VALUE) config.reset()
				else if (value === NEXT_MESSAGE_VALUE) config.toggleNextMessageOnly()
				else config.select(value)
			}}
			value={config.current?.id ?? ""}>
			<SelectTrigger
				aria-label={`${config.modeLabel} configuration`}
				className="h-5 min-w-0 max-w-40 shrink gap-0.5 rounded-xs border-0 bg-transparent px-1 py-0 text-xs text-description shadow-none hover:text-foreground focus-visible:ring-0 data-[size=default]:h-5 [&_svg]:size-2.5"
				data-testid="config-picker"
				title={config.description}>
				<SelectValue placeholder={fallbackLabel}>
					<span className="truncate">
						{config.label}
						{config.pending ? " (pending)" : ""}
						{config.scopeLabel && <span className="ml-1 opacity-60">{config.scopeLabel}</span>}
					</span>
				</SelectValue>
			</SelectTrigger>
			<SelectContent align="start" className="menu-rise" side="top">
				{config.profiles.map((profile) => (
					<SelectItem className="text-xs" key={profile.id} value={profile.id}>
						<span className="truncate">{profile.name}</span>
					</SelectItem>
				))}
				{config.profiles.length > 0 && <SelectSeparator />}
				<SelectItem className="text-xs text-description" value={RESET_CONFIGURATION_VALUE}>
					Reset to default
				</SelectItem>
				{config.hasChat && (
					<SelectItem className="text-xs text-description" disabled={config.busy} value={NEXT_MESSAGE_VALUE}>
						{config.nextMessageOnly ? "Keep for this chat" : "Use next choice for next message only"}
					</SelectItem>
				)}
				<SelectItem className="text-xs text-description" value={MANAGE_CONFIGURATIONS_VALUE}>
					Manage configurations…
				</SelectItem>
			</SelectContent>
		</Select>
	)
}

export default memo(ConfigPicker)
