import type { ModelInfo } from "@shared/api"
import { type Mode, OPENAI_REASONING_EFFORT_OPTIONS, type OpenaiReasoningEffort } from "@shared/storage/types"
import { ShieldOffIcon } from "lucide-react"
import { memo, useRef, useState } from "react"
import { COMPOSER_MENU_SCROLL_CLASS, MENU_SEPARATOR_CLASS } from "@/components/common/menuStyles"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { cn } from "@/lib/utils"
import { ApprovalTiles } from "./ApprovalTiles"
import { approvalsLabel, summarizeApprovals } from "./approvals"
import { DoubleWheel, type WheelItem } from "./DoubleWheel"
import {
	type ComposerSelectionChanges,
	formatEffort,
	formatEffortShort,
	useConfigSelection,
	useEffortSelection,
} from "./modelSelection"

/** The chip's codicon chevron, as on the other composer chips. */
export const ChipChevron = () => <span aria-hidden className="codicon codicon-chevron-down shrink-0 text-[10px]! opacity-70" />

/** Stands in for the current pick when it isn't one of the saved models (none assigned yet). */
const UNSAVED_VALUE = "__unsaved__"

/** Why a locked choice can't change. */
export const LOCKED_REASON = "A next-message-only choice can't change while Cline is working"

// Text-only feedback: the chip brightens on hover, focus or open; no background highlight.
const CHIP_CLASS =
	"flex h-5 min-w-0 cursor-pointer items-center gap-[0.3em] rounded-xs border-0 bg-transparent px-1 py-0 text-xs text-description transition-colors duration-100 hover:text-foreground focus-visible:text-foreground motion-reduce:transition-none focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-(--vscode-focusBorder) data-[state=open]:text-foreground"

const FOOTER_BUTTON_CLASS =
	"flex h-5 cursor-pointer items-center gap-1 whitespace-nowrap rounded-xs border-0 bg-transparent px-1 text-[11px] text-description hover:text-foreground focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-(--vscode-focusBorder) disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:text-description"

/** The wheel's names for the efforts: "none" reads "Default" (its tooltip says whose). */
const EFFORT_ITEMS: WheelItem[] = OPENAI_REASONING_EFFORT_OPTIONS.map((option) => ({
	value: option,
	label: option === "none" ? "Default" : formatEffort(option),
	detail: option === "none" ? "Provider default" : undefined,
}))

/** What the menu's wheels show; nothing is saved until the menu closes with it kept. */
interface Draft {
	profile: string
	effort: OpenaiReasoningEffort
	/** The effort was rolled by hand: a model change keeps it instead of taking that model's own. */
	effortTouched: boolean
}

interface ModelEffortChipProps {
	mode: Mode
	/** Shown when no saved model is assigned (e.g. before any exist). */
	fallbackLabel: string
	modelId: string | undefined
	modelInfo: ModelInfo | undefined
	defaultEffort?: OpenaiReasoningEffort
	/** A narrow row: the effort word hides from the chip so the model name keeps its letters. */
	compactEffort?: boolean
}

/**
 * The composer's one readable chip, "Opus 4.5 High". A click opens one menu above it: the five
 * auto-approve tiles, then a double wheel (model | effort) whose middle row is the choice, then
 * Reset, Next message only and the Models page. Enter, a click outside or Tab away keep what the
 * wheels show; Escape puts the previous choice back. With every action auto-approved, an
 * error-colored shield sits before the chip text.
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
	const permissionsLabel = approvalsLabel(autoApprovalSettings)
	const [draft, setDraftState] = useState<Draft | null>(null)
	const draftRef = useRef<Draft | null>(null)
	const escapingRef = useRef(false)
	const wheelsRef = useRef<HTMLDivElement>(null)
	const open = draft !== null

	const setDraft = (next: Draft | null) => {
		draftRef.current = next
		setDraftState(next)
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

	/** The effort a saved model brings with it when picked (the extension applies the same). */
	const profileEffort = (id: string): OpenaiReasoningEffort =>
		id === modelValue ? effort.selected : (config.profiles.find((profile) => profile.id === id)?.reasoningEffort ?? "none")
	// Only the current model's info is known here; another saved model is offered its efforts.
	const effortAvailableFor = (id: string) => (id === modelValue ? effort.available : true)

	/** Saves what the wheels show (plus `extra`) in one request, only what changed. */
	const commit = (extra: ComposerSelectionChanges = {}) => {
		const current = draftRef.current
		const changes: ComposerSelectionChanges = { ...extra }
		if (current) {
			const modelChanged = !config.locked && current.profile !== modelValue && current.profile !== UNSAVED_VALUE
			if (modelChanged) changes.profileId = current.profile
			const baseline = modelChanged ? profileEffort(current.profile) : effort.selected
			if (!effort.locked && effortAvailableFor(current.profile) && current.effort !== baseline) {
				changes.reasoningEffort = current.effort
			}
		}
		if (Object.keys(changes).length > 0) config.assign(changes)
	}

	const openMenu = () => {
		escapingRef.current = false
		setDraft({ profile: modelValue, effort: effort.selected, effortTouched: false })
	}
	const closeMenu = (keep: boolean) => {
		if (!draftRef.current) return
		if (keep) commit()
		setDraft(null)
	}

	const draftProfile = draft?.profile ?? modelValue
	const draftEffort = draft?.effort ?? effort.selected
	const showEffort = effortAvailableFor(draftProfile)
	const note = config.locked ? LOCKED_REASON : config.profiles.length === 0 ? "No saved models yet" : undefined

	const chipLabel = [
		`${config.modeLabel} model: ${config.label}`,
		effort.available ? `, effort ${formatEffort(effort.selected)}` : "",
		`; ${permissionsLabel}`,
	].join("")

	return (
		<Popover onOpenChange={(next) => (next ? openMenu() : closeMenu(!escapingRef.current))} open={open}>
			<PopoverTrigger asChild>
				<button
					aria-label={chipLabel}
					className={CHIP_CLASS}
					data-testid="model-effort-chip"
					title={[config.description, effort.available && effort.description, permissionsLabel]
						.filter(Boolean)
						.join("\n")}
					type="button">
					{fullAccess && (
						<ShieldOffIcon aria-hidden className="shrink-0 text-error" data-testid="full-access-icon" size={12} />
					)}
					<span className="min-w-[3ch] truncate" data-testid="chip-model">
						{config.label}
					</span>
					{config.pending && <span className="shrink-0 opacity-60">(pending)</span>}
					{config.nextMessageOnly && <span className="shrink-0 opacity-60">next message</span>}
					{/* A narrow row hides the effort word; the menu still has it. */}
					{effort.available && !compactEffort && (
						<span className="shrink-0 whitespace-nowrap" data-testid="chip-effort">
							{formatEffortShort(effort.selected)}
							{effort.pending ? " (pending)" : ""}
						</span>
					)}
					<ChipChevron />
				</button>
			</PopoverTrigger>
			<PopoverContent
				align="end"
				aria-label={`${config.modeLabel} model, effort and auto-approve`}
				className={cn("menu-rise w-[260px] max-w-[calc(100vw-8px)] p-1.5 text-xs", COMPOSER_MENU_SCROLL_CLASS)}
				collisionPadding={4}
				data-testid="model-menu"
				onEscapeKeyDown={() => {
					escapingRef.current = true
				}}
				onOpenAutoFocus={(event) => {
					// Focus lands on the wheels (the column with the tab stop), not the first tile.
					event.preventDefault()
					wheelsRef.current
						?.querySelector<HTMLElement>('[role="listbox"][tabindex="0"]')
						?.focus({ preventScroll: true })
				}}
				role="dialog"
				side="top"
				sideOffset={6}>
				<ApprovalTiles />
				<hr className={MENU_SEPARATOR_CLASS} />
				<DoubleWheel
					effort={
						showEffort
							? {
									label: "Reasoning effort",
									items: EFFORT_ITEMS,
									index: Math.max(0, OPENAI_REASONING_EFFORT_OPTIONS.indexOf(draftEffort)),
									onSelect: (index) => {
										const current = draftRef.current
										if (current)
											setDraft({
												...current,
												effort: OPENAI_REASONING_EFFORT_OPTIONS[index],
												effortTouched: true,
											})
									},
									disabled: effort.locked,
									disabledReason: LOCKED_REASON,
								}
							: undefined
					}
					model={{
						label: `${config.modeLabel} model`,
						items: modelItems,
						index: Math.max(
							0,
							modelItems.findIndex((item) => item.value === draftProfile),
						),
						onSelect: (index) => {
							const current = draftRef.current
							const profile = modelItems[index]?.value
							if (!current || !profile) return
							setDraft({
								...current,
								profile,
								effort: current.effortTouched ? current.effort : profileEffort(profile),
							})
						},
						disabled: config.locked,
						disabledReason: LOCKED_REASON,
					}}
					onEnter={() => closeMenu(true)}
					wheelsRef={wheelsRef}
				/>
				{note && (
					<p
						className="m-0 flex items-center gap-1 px-1 pt-1 text-[11px] text-description"
						data-testid="model-menu-note">
						{config.locked && <span aria-hidden className="codicon codicon-lock text-[11px]!" />}
						{note}
					</p>
				)}
				<div className="mt-1 flex flex-wrap items-center gap-x-1 border-0 border-t border-solid border-menu-foreground/10 pt-1">
					<button
						aria-label="Reset to default"
						className={FOOTER_BUTTON_CLASS}
						data-testid="menu-reset"
						onClick={() => {
							setDraft(null)
							config.reset()
						}}
						title="Reset to default"
						type="button">
						Reset
					</button>
					{config.hasChat && (
						<button
							className={FOOTER_BUTTON_CLASS}
							data-testid="menu-next-message"
							disabled={config.busy}
							onClick={() => {
								commit({ nextMessageOnly: !config.nextMessageOnly })
								setDraft(null)
							}}
							title={config.busy ? "Can't change while Cline is working" : undefined}
							type="button">
							{config.nextMessageOnly ? "Keep for this chat" : "Next message only"}
						</button>
					)}
					<button
						className={cn(FOOTER_BUTTON_CLASS, "ml-auto text-link hover:text-link-hover")}
						data-testid="menu-models-page"
						onClick={() => {
							closeMenu(true)
							config.manage()
						}}
						title="Open the Models page"
						type="button">
						Models
						<span aria-hidden className="codicon codicon-chevron-right text-[10px]!" />
					</button>
				</div>
			</PopoverContent>
		</Popover>
	)
}

export default memo(ModelEffortChip)
