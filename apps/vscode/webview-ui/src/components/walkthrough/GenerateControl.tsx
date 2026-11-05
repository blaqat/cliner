import type { ModelPick } from "@shared/model-settings"
import type { ModelSettingsState } from "@shared/model-settings-state"
import { useState } from "react"
import { handleMenuKeyDown } from "@/components/chat/composer/menuKeyboard"
import { LinkButton } from "@/components/common/LinkButton"
import { MENU_ICON_CLASS, MENU_ITEM_CLASS, MENU_SEPARATOR_CLASS } from "@/components/common/menuStyles"
import { ModelPickButton } from "@/components/models/ModelPickButton"
import { selectorDataFromModelSettings } from "@/components/models/modelSelectorRows"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import { Box } from "./WalkthroughReviewNotes"

interface GenerateControlProps {
	modelSettings?: ModelSettingsState
	pick?: ModelPick | null
	onPick?: (pick: ModelPick) => void
	/** The document shown is already generated, so the button regenerates. */
	regenerate: boolean
	disabled: boolean
	generating: boolean
	onGenerate: () => void
	onOpenModels: () => void
	/** "Add review notes": Generate also asks Cline for its notes. Remembered by the page. */
	reviewNotes: boolean
	onReviewNotes: (on: boolean) => void
}

/** Both halves share one height, radius and separator so they read as one split button. */
const HALF_CLASS = "h-6 rounded-none py-0 leading-none"

/**
 * `✦ Generate ▾`: the walkthrough's one AI-cost action, as one split button.
 * Runs only on click, on the model picked beside it.
 */
export function GenerateControl({
	modelSettings,
	pick,
	onPick,
	regenerate,
	disabled,
	generating,
	onGenerate,
	onOpenModels,
	reviewNotes,
	onReviewNotes,
}: GenerateControlProps) {
	const [menuOpen, setMenuOpen] = useState(false)
	if (!modelSettings)
		return (
			<LinkButton className="text-[11px]" onClick={onOpenModels}>
				See why Generate isn't available
			</LinkButton>
		)
	return (
		<div className="inline-flex shrink-0 items-stretch overflow-hidden rounded-xs" data-testid="walkthrough-generate">
			<Button
				aria-busy={generating || undefined}
				className={cn(HALF_CLASS, "gap-1 px-2")}
				disabled={disabled || generating}
				onClick={() => (pick ? onGenerate() : setMenuOpen(true))}
				size="xs"
				title="Generate with selected model">
				<span
					aria-hidden
					className={cn(
						"codicon text-[12px]!",
						generating ? "codicon-loading codicon-modifier-spin" : "codicon-sparkle",
					)}
				/>
				{generating ? "Generating…" : regenerate ? "Regenerate" : "Generate"}
			</Button>
			<ModelPickButton
				{...selectorDataFromModelSettings(modelSettings)}
				modelsLabel="Generate model"
				onCommit={(p) => onPick?.({ modelId: p.rowId, levelId: p.levelId })}
				onManage={onOpenModels}
				pick={pick ? { rowId: pick.modelId, levelId: pick.levelId } : null}
			/>
			<Popover onOpenChange={setMenuOpen} open={menuOpen}>
				<PopoverTrigger asChild>
					<Button
						aria-label="Generate options"
						className={cn(HALF_CLASS, "w-5 border-y-0 border-r-0 border-l border-solid border-button-separator px-0")}
						disabled={generating}
						size="xs">
						<span aria-hidden className="codicon codicon-chevron-down text-[12px]!" />
					</Button>
				</PopoverTrigger>
				<PopoverContent align="end" className="menu-rise w-64 p-1" onKeyDown={handleMenuKeyDown} side="bottom">
					<div className="flex flex-col" role="menu">
						<button
							aria-checked={reviewNotes}
							className={cn(MENU_ITEM_CLASS, "h-auto items-start py-1")}
							data-testid="walkthrough-generate-review-notes"
							onClick={() => onReviewNotes(!reviewNotes)}
							role="menuitemcheckbox"
							type="button">
							<span className="mt-0.5">
								<Box on={reviewNotes} />
							</span>
							<span className="min-w-0 flex-1">
								<span className="block">Add review notes</span>
								<span className="block text-[11px] text-description">
									Risks, suggestions and questions. Same request, a bit more output.
								</span>
							</span>
						</button>
						<div className={MENU_SEPARATOR_CLASS} role="separator" />
						<button
							className={cn(MENU_ITEM_CLASS, "text-description")}
							onClick={() => {
								setMenuOpen(false)
								onOpenModels()
							}}
							role="menuitem"
							type="button">
							<span aria-hidden className={cn(MENU_ICON_CLASS, "codicon-settings-gear")} />
							Manage models…
						</button>
					</div>
				</PopoverContent>
			</Popover>
		</div>
	)
}
