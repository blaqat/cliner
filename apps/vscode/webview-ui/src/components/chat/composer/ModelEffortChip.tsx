import type { Mode } from "@shared/storage/types"
import { ShieldOffIcon } from "lucide-react"
import { memo } from "react"
import { ChipChevron, MODEL_CHIP_CLASS } from "@/components/models/ModelPickButton"
import { ModelSelector, type SelectorSlotContext } from "@/components/models/ModelSelector"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { cn } from "@/lib/utils"
import { ApprovalTiles } from "./ApprovalTiles"
import { approvalsLabel, summarizeApprovals } from "./approvals"
import {
	type ComposerSelection,
	LOCKED_REASON,
	NEXT_MESSAGE_TIPS,
	RESET_DISABLED_REASON,
	useComposerSelection,
} from "./composerSelection"

export { LOCKED_REASON, NEXT_MESSAGE_TIPS, RESET_DISABLED_REASON }

const FOCUS_RING =
	"focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-(--vscode-focusBorder)"

const FOOTER_BUTTON_CLASS = cn(
	"flex h-5 cursor-pointer items-center gap-1 whitespace-nowrap rounded-xs border-0 bg-transparent px-1 text-[11px] text-description hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:text-description",
	FOCUS_RING,
)

/** Reset: a square icon button, like the composer's other icon buttons. */
const ICON_BUTTON_CLASS = cn(
	"flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-xs border-0 bg-transparent p-0 text-description hover:bg-toolbar-hover hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-description",
	FOCUS_RING,
)

const SLIDE_CLASS =
	"transition-[transform,background-color,border-color] duration-150 motion-reduce:transition-none [.vscode-reduce-motion_&]:transition-none"

/** Why "Make this the default" is off, if it is. */
function makeDefaultBlock(selection: ComposerSelection, { pick }: SelectorSlotContext): string | undefined {
	if (!pick) return "Pick a model first"
	const row = selection.rows.find((candidate) => candidate.id === pick.rowId)
	if (!row) return "Pick a model first"
	if (row.disabledReason) return row.disabledReason
	if (row.levels && !row.levels.some((level) => level.id === pick.levelId)) {
		return `${row.label} doesn't offer this level: pick another first`
	}
	return undefined
}

/** The composer's extras under the lists: Reset, Next message only, Models and the default line. */
function ComposerMenuFooter({ selection, context }: { selection: ComposerSelection; context: SelectorSlotContext }) {
	const canReset = selection.canReset || context.moved
	const nextOn = selection.nextMessageOnly
	const { makeDefault } = selection
	const defaultBlock = makeDefaultBlock(selection, context)
	const isDefault = !!makeDefault?.isDefault(context.pick)
	return (
		<>
			<div className="mt-1 flex shrink-0 items-center gap-x-1 border-0 border-t border-solid border-menu-foreground/10 pt-1">
				<button
					aria-label={canReset ? "Reset to default" : `Reset to default. ${selection.resetDisabledReason}`}
					className={ICON_BUTTON_CLASS}
					data-testid="menu-reset"
					disabled={!canReset}
					onClick={() => {
						context.close(false)
						selection.reset()
					}}
					title={canReset ? "Reset to the default model and effort" : selection.resetDisabledReason}
					type="button">
					<span aria-hidden className="codicon codicon-discard text-[13px]!" />
				</button>
				{selection.hasChat && (
					// Waits for the close, with what the lists show: Escape drops both.
					<button
						aria-checked={nextOn}
						className={cn(FOOTER_BUTTON_CLASS, "gap-1.5", nextOn && "text-foreground")}
						data-state={nextOn ? "on" : "off"}
						data-testid="menu-next-message"
						disabled={!!selection.nextMessageDisabledReason}
						onClick={() => selection.setNextMessageOnly(!nextOn)}
						role="switch"
						title={selection.nextMessageDisabledReason ?? NEXT_MESSAGE_TIPS[nextOn ? "on" : "off"]}
						type="button">
						<span
							aria-hidden
							className={cn(
								"relative inline-block h-[12px] w-[22px] shrink-0 rounded-full border border-solid",
								SLIDE_CLASS,
								nextOn
									? "border-(--vscode-focusBorder) bg-(--vscode-focusBorder)"
									: "border-description bg-transparent",
							)}
							data-testid="next-message-track">
							<span
								className={cn(
									"absolute top-[2px] left-[2px] size-[6px] rounded-full",
									SLIDE_CLASS,
									nextOn ? "translate-x-[10px] bg-button-foreground" : "bg-description",
								)}
								data-testid="next-message-thumb"
							/>
						</span>
						Next message only
					</button>
				)}
				<button
					className={cn(FOOTER_BUTTON_CLASS, "ml-auto text-link hover:text-link-hover")}
					data-testid="menu-models-page"
					onClick={() => {
						context.close(true)
						selection.manage()
					}}
					title="Open the Models page"
					type="button">
					Models
					<span aria-hidden className="codicon codicon-chevron-right text-[10px]!" />
				</button>
			</div>
			{makeDefault && (
				<div className="mt-1 flex shrink-0 items-center border-0 border-t border-solid border-menu-foreground/10 pt-1">
					{/* The menu stays open: what the lists show is still kept or dropped on close. */}
					<button
						className={cn(FOOTER_BUTTON_CLASS, "w-full")}
						data-testid="menu-make-default"
						disabled={isDefault || !!defaultBlock}
						onClick={() => {
							if (context.pick) makeDefault.run(context.pick)
						}}
						title={isDefault ? "New chats already start with this." : (defaultBlock ?? makeDefault.tip)}
						type="button">
						{isDefault ? "This is the default" : "Make this the default"}
					</button>
				</div>
			)}
		</>
	)
}

interface ModelEffortChipProps {
	mode: Mode
	/** Names what's running until the store exists. */
	fallbackLabel: string
	/** A narrow row: the effort word hides from the chip so the model name keeps its letters. */
	compactEffort?: boolean
	/** The narrowest row: "next" can take the model name's last letters. */
	tightChip?: boolean
}

/**
 * The composer's one readable chip, "Opus 4.5 High". A click opens the one model selector above it,
 * with the five auto-approve tiles on top and Reset, the Next message only switch and the Models page
 * below. With every action auto-approved, an error-colored shield sits before the chip text.
 */
const ModelEffortChip = ({ mode, fallbackLabel, compactEffort = false, tightChip = false }: ModelEffortChipProps) => {
	const { autoApprovalSettings } = useExtensionState()
	const selection = useComposerSelection(mode, fallbackLabel)
	const { level } = selection
	const fullAccess = summarizeApprovals(autoApprovalSettings).approveAll
	const permissionsLabel = approvalsLabel(autoApprovalSettings)

	const chipLabel = [
		`${selection.modeLabel} model: ${selection.modelLabel}`,
		level ? `, effort ${level.word}` : "",
		selection.nextMessageOnly ? ", next message only" : "",
		`; ${permissionsLabel}`,
	].join("")

	return (
		<ModelSelector
			disabledReason={selection.disabledReason}
			footer={(context) => <ComposerMenuFooter context={context} selection={selection} />}
			ladder={selection.ladder}
			menuLabel={`${selection.modeLabel} model, effort and auto-approve`}
			modelsLabel={`${selection.modeLabel} model`}
			note={selection.note}
			noteLink={selection.noteLink}
			onClose={selection.settleNextMessage}
			onCommit={selection.commit}
			onManage={selection.manage}
			pick={selection.pick}
			rows={selection.rows}
			side="top"
			top={<ApprovalTiles />}
			trigger={
				<button
					aria-label={chipLabel}
					className={cn(MODEL_CHIP_CLASS, "overflow-hidden")}
					data-testid="model-effort-chip"
					title={[selection.description, level?.description, permissionsLabel].filter(Boolean).join("\n")}
					type="button">
					{fullAccess && (
						<ShieldOffIcon aria-hidden className="shrink-0 text-error" data-testid="full-access-icon" size={12} />
					)}
					<span
						className={cn("truncate", tightChip && selection.nextMessageOnly ? "min-w-0" : "min-w-[3ch]")}
						data-testid="chip-model">
						{selection.modelLabel}
					</span>
					{selection.pending && <span className="shrink-0 opacity-60">(pending)</span>}
					{selection.nextMessageOnly && (
						<span className="shrink-0 whitespace-nowrap opacity-60" data-testid="chip-next-message">
							{compactEffort ? "next" : "next message"}
						</span>
					)}
					{/* A narrow row hides the effort word; the menu still has it. */}
					{level && !compactEffort && (
						<span className={cn("shrink-0 whitespace-nowrap", level.bad && "text-warning")} data-testid="chip-effort">
							{level.short}
							{level.pending ? " (pending)" : ""}
						</span>
					)}
					<ChipChevron />
				</button>
			}
		/>
	)
}

export default memo(ModelEffortChip)
