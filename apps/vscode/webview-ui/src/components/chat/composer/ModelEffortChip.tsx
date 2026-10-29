import type { ModelInfo } from "@shared/api"
import {
	isOpenaiReasoningEffort,
	type Mode,
	OPENAI_REASONING_EFFORT_OPTIONS,
	type OpenaiReasoningEffort,
} from "@shared/storage/types"
import { ShieldIcon, ShieldOffIcon } from "lucide-react"
import type React from "react"
import { memo, useCallback, useRef, useState } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { cn } from "@/lib/utils"
import { ApprovalToggles } from "./ApprovalToggles"
import { approvalsLabel, summarizeApprovals } from "./approvals"
import { formatEffort, formatEffortShort, useConfigSelection, useEffortSelection } from "./modelSelection"
import { type WheelItem, WheelPopup } from "./WheelPopup"

/** The chip's codicon chevron, as on the other composer chips. */
export const ChipChevron = () => <span aria-hidden className="codicon codicon-chevron-down shrink-0 text-[10px]! opacity-70" />

/** Stands in for the current pick when it isn't one of the saved models (none assigned yet). */
const UNSAVED_VALUE = "__unsaved__"

// Text-only feedback: each part brightens on its own hover, focus or open; no background highlight.
const PART_CLASS =
	"flex h-5 min-w-0 cursor-pointer items-center gap-1 rounded-xs border-0 bg-transparent py-0 text-xs text-inherit transition-colors duration-100 hover:text-foreground focus-visible:text-foreground motion-reduce:transition-none focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-(--vscode-focusBorder) disabled:cursor-not-allowed disabled:opacity-60"

const ACTION_BUTTON_CLASS =
	"flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-xs border-0 bg-transparent p-0 text-description hover:text-foreground focus-visible:text-foreground focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-(--vscode-focusBorder) disabled:cursor-not-allowed disabled:opacity-50"

/** A quiet icon action beside the rolling text; its name is its tooltip. */
const WheelAction = ({
	icon,
	label,
	className,
	...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { icon: string; label: string }) => (
	<button aria-label={label} className={cn(ACTION_BUTTON_CLASS, className)} title={label} type="button" {...props}>
		<span aria-hidden className={`codicon codicon-${icon} text-[12px]!`} />
	</button>
)

interface ModelEffortChipProps {
	mode: Mode
	/** Shown when no saved model is assigned (e.g. before any exist). */
	fallbackLabel: string
	modelId: string | undefined
	modelInfo: ModelInfo | undefined
	defaultEffort?: OpenaiReasoningEffort
	/** A narrow row: the effort text folds into the ⌄ so the model name keeps its letters. */
	compactEffort?: boolean
}

/**
 * The composer's one readable chip, "Opus 4.5 High": the model text and the effort text are two
 * click targets, each rolling its own wheel in place of the text you clicked. The effort wheel
 * has the auto-approve toggles just above it. A model without reasoning control shows the
 * approvals' shield in place of the effort. With every action auto-approved, an error-colored
 * shield sits before the model text.
 */
const ModelEffortChip = ({
	mode,
	fallbackLabel,
	modelId,
	modelInfo,
	defaultEffort = "none",
	compactEffort = false,
}: ModelEffortChipProps) => {
	const { autoApprovalSettings } = useExtensionState()
	const config = useConfigSelection(mode, fallbackLabel)
	const effort = useEffortSelection(mode, { modelId, modelInfo, defaultEffort })
	const fullAccess = summarizeApprovals(autoApprovalSettings).approveAll
	const [open, setOpen] = useState<"model" | "effort" | null>(null)
	const [aligned, setAligned] = useState(false)
	const modelButtonRef = useRef<HTMLButtonElement>(null)
	const modelTextRef = useRef<HTMLSpanElement>(null)
	const effortButtonRef = useRef<HTMLButtonElement>(null)
	const effortTextRef = useRef<HTMLSpanElement>(null)

	const close = useCallback(() => setOpen(null), [])
	const toggle = (which: "model" | "effort") => setOpen((current) => (current === which ? null : which))

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
			<WheelAction
				data-testid="wheel-next-message"
				disabled={selection.busy}
				icon={selection.nextMessageOnly ? "pinned" : "arrow-right"}
				label={
					selection.busy
						? "Can't change while Cline is working"
						: selection.nextMessageOnly
							? "Keep for this chat"
							: "Next message only"
				}
				onClick={() => {
					selection.toggleNextMessageOnly()
					close()
					trigger.current?.focus()
				}}
			/>
		)

	const PermissionIcon = fullAccess ? ShieldOffIcon : ShieldIcon
	const permissionsLabel = approvalsLabel(autoApprovalSettings)

	return (
		<div className="flex h-5 min-w-0 items-center rounded-xs text-xs text-description" data-testid="model-effort-chip">
			<button
				aria-expanded={open === "model"}
				aria-haspopup="dialog"
				aria-label={`${config.modeLabel} model: ${config.label}${fullAccess ? " (every action auto-approved)" : ""}`}
				// The two parts read as words ("Opus 4.5 High"): about a space between them.
				className={cn(PART_CLASS, "shrink pr-[0.3em] pl-1", open === "model" && "text-foreground")}
				data-testid="config-picker"
				disabled={config.locked}
				onClick={() => toggle("model")}
				ref={modelButtonRef}
				title={config.locked ? "A next-message-only choice can't change while Cline is working" : config.description}
				type="button">
				{fullAccess && (
					<ShieldOffIcon aria-hidden className="shrink-0 text-error" data-testid="full-access-icon" size={12} />
				)}
				<span className={cn("min-w-[3ch] truncate", open === "model" && aligned && "invisible")} ref={modelTextRef}>
					{config.label}
				</span>
				{config.pending && <span className="shrink-0 opacity-60">(pending)</span>}
				{config.nextMessageOnly && <span className="shrink-0 opacity-60">next message</span>}
			</button>
			<button
				aria-expanded={open === "effort"}
				aria-haspopup="dialog"
				aria-label={
					effort.available
						? `Reasoning effort: ${formatEffort(effort.selected)}; ${permissionsLabel}`
						: permissionsLabel
				}
				className={cn(PART_CLASS, "shrink-0 pr-1 pl-0", open === "effort" && "text-foreground")}
				data-testid={effort.available ? "reasoning-effort-picker" : "permissions-picker"}
				onClick={() => toggle("effort")}
				ref={effortButtonRef}
				title={effort.available ? `${effort.description} · ${permissionsLabel}` : permissionsLabel}
				type="button">
				{effort.available ? (
					// A narrow row folds the effort text into the ⌄; the wheel then opens from the button.
					!compactEffort && (
						// The model wheel's rolling text may run over it: it steps aside while that wheel is open.
						<span
							className={cn("truncate", ((open === "effort" && aligned) || open === "model") && "invisible")}
							ref={effortTextRef}>
							{formatEffortShort(effort.selected)}
							{effort.pending ? " (pending)" : ""}
						</span>
					)
				) : (
					<PermissionIcon aria-hidden className={cn("shrink-0", fullAccess && "text-error")} size={12} />
				)}
				<ChipChevron />
			</button>

			<WheelPopup
				actions={
					<>
						<WheelAction
							data-testid="wheel-reset"
							icon="discard"
							label="Reset to default"
							onClick={() => {
								config.reset()
								close()
								modelButtonRef.current?.focus()
							}}
						/>
						{nextMessageButton(config, modelButtonRef)}
						<WheelAction
							data-testid="wheel-models-page"
							icon="settings-gear"
							label="Models page"
							onClick={() => {
								close()
								config.manage()
							}}
						/>
					</>
				}
				anchorRef={modelTextRef}
				items={modelItems}
				label={`${config.modeLabel} model`}
				note={config.profiles.length === 0 ? "No saved models yet" : undefined}
				onAlignedChange={setAligned}
				onClose={close}
				onPick={(value) => {
					if (value !== UNSAVED_VALUE) config.select(value)
				}}
				open={open === "model"}
				testId="model-wheel"
				triggerRef={modelButtonRef}
				value={modelValue}
			/>
			<WheelPopup
				actions={
					effort.available ? (
						<>
							<WheelAction
								data-testid="wheel-reset"
								icon="discard"
								label="Reset to default"
								onClick={() => {
									effort.reset()
									close()
									effortButtonRef.current?.focus()
								}}
							/>
							{nextMessageButton(effort, effortButtonRef)}
						</>
					) : undefined
				}
				anchorRef={effort.available ? effortTextRef : effortButtonRef}
				header={<ApprovalToggles />}
				items={effort.available && !effort.locked ? effortItems : undefined}
				label={effort.available ? "Reasoning effort and auto-approve" : "Auto-approve"}
				note={effort.available && effort.locked ? "Effort can't change while Cline is working" : undefined}
				onAlignedChange={setAligned}
				onClose={close}
				onPick={(value) => {
					if (isOpenaiReasoningEffort(value)) effort.select(value)
				}}
				open={open === "effort"}
				testId="effort-wheel"
				triggerRef={effortButtonRef}
				value={effort.selected}
			/>
		</div>
	)
}

export default memo(ModelEffortChip)
