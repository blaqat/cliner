import type { Mode } from "@shared/storage/types"
import { memo } from "react"
import { MENU_ICON_CLASS, MENU_SEPARATOR_CLASS } from "@/components/common/menuStyles"
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select"
import { cn } from "@/lib/utils"
import { useConfigSelection } from "./modelSelection"

/** Sentinel value for the "Manage configurations…" entry; never assigned. */
export const MANAGE_CONFIGURATIONS_VALUE = "__manage_configurations__"
export const RESET_CONFIGURATION_VALUE = "__reset_configuration__"
export const NEXT_MESSAGE_VALUE = "__next_message__"

/**
 * The composer chips (configuration, effort): text-only like before, with the ＋ button's hover,
 * open and focus treatment so the row reads as one toolbar.
 */
export const CHIP_TRIGGER_CLASS =
	"h-5 min-w-0 shrink gap-0.5 rounded-xs border-0 bg-transparent px-1 py-0 text-xs text-description shadow-none hover:bg-toolbar-hover hover:text-foreground focus-visible:outline focus-visible:outline-1 focus-visible:outline-(--vscode-focusBorder) focus-visible:ring-0 data-[size=default]:h-5 data-[state=open]:bg-toolbar-hover data-[state=open]:text-foreground"

/** Chip menu rows: the popover menus' 24px rows and hover color. */
export const CHIP_ITEM_CLASS = "h-6 text-[12px] focus:bg-list-hover focus:text-menu-foreground"
export const CHIP_SEPARATOR_CLASS = MENU_SEPARATOR_CLASS

/** The chip's codicon chevron, as on the where pill. */
export const ChipChevron = () => <span aria-hidden className="codicon codicon-chevron-down shrink-0 text-[10px]! opacity-70" />

/** A menu action (Reset, next message only, Manage…): codicon + muted label. */
export const ChipAction = ({ icon, children }: { icon: string; children: React.ReactNode }) => (
	<>
		<span aria-hidden className={cn(MENU_ICON_CLASS, `codicon-${icon}`)} />
		{children}
	</>
)

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
				className={cn(CHIP_TRIGGER_CLASS, "max-w-40")}
				data-testid="config-picker"
				showIcon={false}
				title={config.description}>
				<SelectValue placeholder={fallbackLabel}>
					<span className="truncate">
						{config.label}
						{config.pending ? " (pending)" : ""}
						{config.scopeLabel && <span className="ml-1 opacity-60">{config.scopeLabel}</span>}
					</span>
				</SelectValue>
				<ChipChevron />
			</SelectTrigger>
			<SelectContent align="start" className="menu-rise" side="top">
				{config.profiles.map((profile) => (
					<SelectItem className={CHIP_ITEM_CLASS} key={profile.id} value={profile.id}>
						<span className="truncate">{profile.name}</span>
					</SelectItem>
				))}
				{config.profiles.length > 0 && <SelectSeparator className={CHIP_SEPARATOR_CLASS} />}
				<SelectItem className={cn(CHIP_ITEM_CLASS, "text-description")} value={RESET_CONFIGURATION_VALUE}>
					<ChipAction icon="discard">Reset to default</ChipAction>
				</SelectItem>
				{config.hasChat && (
					<SelectItem
						className={cn(CHIP_ITEM_CLASS, "text-description")}
						disabled={config.busy}
						value={NEXT_MESSAGE_VALUE}>
						<ChipAction icon={config.nextMessageOnly ? "pinned" : "arrow-right"}>
							{config.nextMessageOnly ? "Keep for this chat" : "Use next choice for next message only"}
						</ChipAction>
					</SelectItem>
				)}
				<SelectItem className={cn(CHIP_ITEM_CLASS, "text-description")} value={MANAGE_CONFIGURATIONS_VALUE}>
					<ChipAction icon="settings-gear">Manage configurations…</ChipAction>
				</SelectItem>
			</SelectContent>
		</Select>
	)
}

export default memo(ConfigPicker)
