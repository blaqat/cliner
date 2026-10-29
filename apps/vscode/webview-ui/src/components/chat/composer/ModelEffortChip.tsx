import type { ModelInfo } from "@shared/api"
import {
	isOpenaiReasoningEffort,
	type Mode,
	OPENAI_REASONING_EFFORT_OPTIONS,
	type OpenaiReasoningEffort,
} from "@shared/storage/types"
import { ShieldIcon, ShieldOffIcon } from "lucide-react"
import type React from "react"
import { memo, type ReactNode, useCallback, useRef, useState } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { cn } from "@/lib/utils"
import { formatEffort, formatEffortShort, useConfigSelection, useEffortSelection } from "./modelSelection"
import { PermissionsPanel } from "./PermissionsPanel"
import { matchPermissionPreset } from "./permissionPresets"
import { type WheelItem, WheelPopup } from "./WheelPopup"

/** The chip's codicon chevron, as on the other composer chips. */
export const ChipChevron = () => <span aria-hidden className="codicon codicon-chevron-down shrink-0 text-[10px]! opacity-70" />

/** Stands in for the current pick when it isn't one of the saved models (none assigned yet). */
const UNSAVED_VALUE = "__unsaved__"

const PART_CLASS =
	"flex h-5 min-w-0 cursor-pointer items-center gap-1 rounded-xs border-0 bg-transparent px-1 py-0 text-xs text-inherit hover:text-foreground focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-(--vscode-focusBorder) disabled:cursor-not-allowed disabled:opacity-60"

const FOOTER_BUTTON_CLASS =
	"flex cursor-pointer items-center gap-1 border-0 bg-transparent p-0 text-[11px] text-description hover:text-foreground focus-visible:outline focus-visible:outline-1 focus-visible:outline-(--vscode-focusBorder) disabled:cursor-not-allowed disabled:opacity-50"

const WheelFooter = ({ children, note }: { children: ReactNode; note?: ReactNode }) => (
	<div className="mt-1 flex shrink-0 flex-col gap-0.5 border-t border-solid border-x-0 border-b-0 border-menu-foreground/10 px-2 pt-1 pb-0.5">
		{note && <div className="text-[11px] text-description">{note}</div>}
		<div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">{children}</div>
	</div>
)

const FooterButton = ({
	icon,
	children,
	className,
	...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { icon: string }) => (
	<button className={cn(FOOTER_BUTTON_CLASS, className)} type="button" {...props}>
		<span aria-hidden className={`codicon codicon-${icon} text-[11px]!`} />
		{children}
	</button>
)

interface ModelEffortChipProps {
	mode: Mode
	/** Shown when no saved model is assigned (e.g. before any exist). */
	fallbackLabel: string
	modelId: string | undefined
	modelInfo: ModelInfo | undefined
	defaultEffort?: OpenaiReasoningEffort
}

/**
 * The composer's one readable chip, "Opus 4.5 · High": the model text and the effort text are two
 * click targets, each opening its own wheel right over the text you clicked. The effort popup
 * also holds the permissions (four presets, or each action). A model without reasoning control
 * shows the permissions icon in place of the effort. With Full access on, an error-colored
 * shield sits before the model text.
 */
const ModelEffortChip = ({ mode, fallbackLabel, modelId, modelInfo, defaultEffort = "none" }: ModelEffortChipProps) => {
	const { autoApprovalSettings } = useExtensionState()
	const config = useConfigSelection(mode, fallbackLabel)
	const effort = useEffortSelection(mode, { modelId, modelInfo, defaultEffort })
	const preset = matchPermissionPreset(autoApprovalSettings)
	const fullAccess = preset?.id === "full"
	const [open, setOpen] = useState<"model" | "effort" | null>(null)
	const [aligned, setAligned] = useState(false)
	const [actionsExpanded, setActionsExpanded] = useState(false)
	const modelButtonRef = useRef<HTMLButtonElement>(null)
	const modelTextRef = useRef<HTMLSpanElement>(null)
	const effortButtonRef = useRef<HTMLButtonElement>(null)
	const effortTextRef = useRef<HTMLSpanElement>(null)

	const close = useCallback(() => {
		setOpen(null)
		setActionsExpanded(false)
	}, [])
	const toggle = (which: "model" | "effort") => {
		setActionsExpanded(false)
		setOpen((current) => (current === which ? null : which))
	}

	// The model wheel: the saved models (as the old picker listed them); a current pick that isn't saved goes first.
	const modelItems: WheelItem[] = config.profiles.map((profile) => ({
		value: profile.id,
		label: profile.name,
		detail: profile.modelId,
	}))
	const modelValue = config.current?.id ?? UNSAVED_VALUE
	if (!config.current) {
		modelItems.unshift({
			value: UNSAVED_VALUE,
			label: fallbackLabel,
			detail: config.profiles.length ? "not saved" : undefined,
		})
	}
	const effortItems: WheelItem[] = OPENAI_REASONING_EFFORT_OPTIONS.map((option) => ({
		value: option,
		label: formatEffort(option),
	}))

	const nextMessageButton = (
		selection: { hasChat: boolean; busy: boolean; nextMessageOnly: boolean; toggleNextMessageOnly: () => void },
		trigger: React.RefObject<HTMLButtonElement | null>,
	) =>
		selection.hasChat && (
			<FooterButton
				data-testid="wheel-next-message"
				disabled={selection.busy}
				icon={selection.nextMessageOnly ? "pinned" : "arrow-right"}
				onClick={() => {
					selection.toggleNextMessageOnly()
					close()
					trigger.current?.focus()
				}}
				title={selection.busy ? "Can't change while Cline is working" : undefined}>
				{selection.nextMessageOnly ? "Keep for this chat" : "Next message only"}
			</FooterButton>
		)

	const PermissionIcon = preset?.icon ?? ShieldIcon
	const permissionsLabel = `Permissions: ${preset ? preset.name : "Custom"}`

	return (
		<div
			className={cn(
				"flex h-5 min-w-0 items-center rounded-xs text-xs text-description hover:bg-toolbar-hover",
				open && "bg-toolbar-hover",
			)}
			data-testid="model-effort-chip">
			<button
				aria-expanded={open === "model"}
				aria-haspopup="dialog"
				aria-label={`${config.modeLabel} model: ${config.label}${fullAccess ? " (Full access on)" : ""}`}
				className={cn(PART_CLASS, "shrink", open === "model" && "text-foreground")}
				data-testid="config-picker"
				disabled={config.locked}
				onClick={() => toggle("model")}
				ref={modelButtonRef}
				title={config.locked ? "A next-message-only choice can't change while Cline is working" : config.description}
				type="button">
				{fullAccess && (
					<ShieldOffIcon aria-hidden className="shrink-0 text-error" data-testid="full-access-icon" size={12} />
				)}
				<span className={cn("min-w-0 truncate", open === "model" && aligned && "invisible")} ref={modelTextRef}>
					{config.label}
				</span>
				{config.pending && <span className="shrink-0 opacity-60">(pending)</span>}
				{config.nextMessageOnly && <span className="shrink-0 opacity-60">next message</span>}
			</button>
			{effort.available && (
				<span aria-hidden className="shrink-0 opacity-60">
					·
				</span>
			)}
			<button
				aria-expanded={open === "effort"}
				aria-haspopup="dialog"
				aria-label={
					effort.available
						? `Reasoning effort: ${formatEffort(effort.selected)}; ${permissionsLabel}`
						: permissionsLabel
				}
				className={cn(PART_CLASS, "shrink-0", open === "effort" && "text-foreground")}
				data-testid={effort.available ? "reasoning-effort-picker" : "permissions-picker"}
				onClick={() => toggle("effort")}
				ref={effortButtonRef}
				title={effort.available ? `${effort.description} · ${permissionsLabel}` : permissionsLabel}
				type="button">
				{effort.available ? (
					<span className={cn("truncate", open === "effort" && aligned && "invisible")} ref={effortTextRef}>
						{formatEffortShort(effort.selected)}
						{effort.pending ? " (pending)" : ""}
					</span>
				) : (
					<PermissionIcon aria-hidden className={cn("shrink-0", fullAccess && "text-error")} size={12} />
				)}
				<ChipChevron />
			</button>

			<WheelPopup
				anchorRef={modelTextRef}
				footer={
					<WheelFooter
						note={
							config.profiles.length === 0
								? "No saved models yet. Save one on the Models page to switch here."
								: undefined
						}>
						<FooterButton
							data-testid="wheel-reset"
							icon="discard"
							onClick={() => {
								config.reset()
								close()
								modelButtonRef.current?.focus()
							}}>
							Reset to default
						</FooterButton>
						{nextMessageButton(config, modelButtonRef)}
						<FooterButton
							className="ml-auto text-link hover:text-link-hover"
							data-testid="wheel-models-page"
							icon="settings-gear"
							onClick={() => {
								close()
								config.manage()
							}}>
							Models page
						</FooterButton>
					</WheelFooter>
				}
				items={modelItems}
				label={`${config.modeLabel} model`}
				onAlignedChange={setAligned}
				onClose={close}
				onPick={(value) => {
					if (value !== UNSAVED_VALUE) config.select(value)
				}}
				open={open === "model"}
				testId="model-wheel"
				triggerRef={modelButtonRef}
				value={modelValue}
				width={240}
			/>
			<WheelPopup
				anchorRef={effort.available ? effortTextRef : effortButtonRef}
				footer={
					effort.available ? (
						<WheelFooter
							note={effort.locked ? "The next-message effort can't change while Cline is working." : undefined}>
							<FooterButton
								data-testid="wheel-reset"
								icon="discard"
								onClick={() => {
									effort.reset()
									close()
									effortButtonRef.current?.focus()
								}}>
								Reset to default
							</FooterButton>
							{nextMessageButton(effort, effortButtonRef)}
						</WheelFooter>
					) : undefined
				}
				header={
					<PermissionsPanel
						divider={effort.available && !effort.locked && !actionsExpanded}
						expanded={actionsExpanded}
						onToggleExpanded={() => setActionsExpanded((v) => !v)}
					/>
				}
				// The per-action list takes the wheel's place, so the popup keeps one scroll area.
				items={effort.available && !effort.locked && !actionsExpanded ? effortItems : undefined}
				label={effort.available ? "Reasoning effort and permissions" : "Permissions"}
				onAlignedChange={setAligned}
				onClose={close}
				onPick={(value) => {
					if (isOpenaiReasoningEffort(value)) effort.select(value)
				}}
				open={open === "effort"}
				testId="effort-wheel"
				triggerRef={effortButtonRef}
				value={effort.selected}
				width={264}
			/>
		</div>
	)
}

export default memo(ModelEffortChip)
