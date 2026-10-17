import type { ModelInfo } from "@shared/api"
import { type Mode, OPENAI_REASONING_EFFORT_OPTIONS, type OpenaiReasoningEffort } from "@shared/storage/types"
import { memo, useState } from "react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import { handleMenuKeyDown, MENU_HEADING_CLASS, MENU_ROW_CLASS } from "./menuKeyboard"
import { formatEffort, useConfigSelection, useEffortSelection } from "./modelSelection"

interface ModelEffortPillProps {
	mode: Mode
	/** Shown when no saved configuration is assigned (e.g. before any exist). */
	fallbackLabel: string
	modelId: string | undefined
	modelInfo: ModelInfo | undefined
	defaultEffort?: OpenaiReasoningEffort
}

const shortEffort = (effort: OpenaiReasoningEffort) => (effort === "none" ? "Default" : formatEffort(effort))

/**
 * One pill for the mode's configuration (API profile) and reasoning effort. Picking either updates
 * this chat, or the next-chat draft on the home screen, without touching Settings; the menu stays
 * open so both can be set in one go.
 */
const ModelEffortPill = ({ mode, fallbackLabel, modelId, modelInfo, defaultEffort = "none" }: ModelEffortPillProps) => {
	const config = useConfigSelection(mode, fallbackLabel)
	const effort = useEffortSelection(mode, { modelId, modelInfo, defaultEffort })
	const [open, setOpen] = useState(false)
	const pending = config.pending || (effort.available && effort.pending)
	const title = [config.description, effort.available ? `effort ${formatEffort(effort.selected)}` : undefined]
		.filter(Boolean)
		.join(" · ")
	const effortLabel = effort.available && effort.selected !== "none" ? formatEffort(effort.selected) : undefined

	return (
		<Popover onOpenChange={setOpen} open={open}>
			<PopoverTrigger asChild>
				<button
					aria-label={`${config.modeLabel} configuration: ${config.label}${effortLabel ? `, ${effortLabel} effort` : ""}`}
					className={cn(
						"flex h-4.5 min-w-6 max-w-48 shrink cursor-pointer items-center gap-1 overflow-hidden rounded-full border border-description/40 bg-transparent px-1.5 text-[11px] leading-none whitespace-nowrap text-description hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60",
						open && "border-(--vscode-focusBorder) text-foreground",
					)}
					data-testid="model-effort-pill"
					disabled={config.locked}
					title={title}
					type="button">
					<span className="min-w-0 truncate">
						{config.label}
						{pending ? " (pending)" : ""}
						{effortLabel && <span data-testid="model-effort-pill-effort"> · {effortLabel}</span>}
						{config.scopeLabel && <span className="ml-1 opacity-60">{config.scopeLabel}</span>}
					</span>
					<span aria-hidden className="codicon codicon-chevron-down shrink-0 text-[10px]! opacity-70" />
				</button>
			</PopoverTrigger>
			<PopoverContent
				align="start"
				className="menu-rise w-64 p-1"
				data-testid="model-effort-menu"
				onKeyDown={handleMenuKeyDown}
				side="top">
				<div aria-label={`${config.modeLabel} configuration`} role="menu">
					<div className={MENU_HEADING_CLASS}>{config.modeLabel} profile</div>
					{config.profiles.map((profile) => (
						<button
							aria-checked={profile.id === config.current?.id}
							className={MENU_ROW_CLASS}
							key={profile.id}
							onClick={() => config.select(profile.id)}
							role="menuitemradio"
							title={`${profile.provider}:${profile.modelId}`}
							type="button">
							<span className="min-w-0 flex-1 truncate">{profile.name}</span>
							<span className="max-w-24 shrink truncate text-[10.5px] text-description">{profile.modelId}</span>
							<span
								aria-hidden
								className={cn(
									"codicon codicon-check text-[12px]!",
									profile.id !== config.current?.id && "invisible",
								)}
							/>
						</button>
					))}
					{config.profiles.length === 0 && <div className="px-2 py-1 text-xs text-description">{fallbackLabel}</div>}
					{effort.available && (
						<>
							<div className={MENU_HEADING_CLASS} title={effort.description}>
								Effort{effort.pending ? " (pending)" : ""}
							</div>
							<div
								aria-label="Reasoning effort"
								className="flex flex-wrap gap-0.5 px-1.5 pb-1"
								data-testid="effort-choices"
								role="group">
								{OPENAI_REASONING_EFFORT_OPTIONS.map((option) => (
									<button
										aria-checked={effort.selected === option}
										aria-label={formatEffort(option)}
										className={cn(
											"h-5 cursor-pointer rounded-xs border px-1.5 text-[11px] leading-none focus-visible:outline-1 focus-visible:outline-(--vscode-focusBorder)",
											effort.selected === option
												? "border-(--vscode-focusBorder) bg-button-background text-button-foreground"
												: "border-menu-foreground/15 bg-transparent text-menu-foreground hover:bg-list-hover",
										)}
										key={option}
										onClick={() => effort.select(option)}
										role="menuitemradio"
										title={formatEffort(option)}
										type="button">
										{shortEffort(option)}
									</button>
								))}
							</div>
						</>
					)}
					<div className="my-1 border-t border-menu-foreground/10" />
					<button
						className={cn(MENU_ROW_CLASS, "text-description")}
						onClick={() => {
							setOpen(false)
							config.reset()
						}}
						role="menuitem"
						type="button">
						Reset to default
					</button>
					{config.hasChat && (
						<button
							className={cn(MENU_ROW_CLASS, "text-description")}
							disabled={config.busy}
							onClick={config.toggleNextMessageOnly}
							role="menuitem"
							type="button">
							{config.nextMessageOnly ? "Keep for this chat" : "Use next choice for next message only"}
						</button>
					)}
					<button
						className={cn(MENU_ROW_CLASS, "text-description")}
						onClick={() => {
							setOpen(false)
							config.manage()
						}}
						role="menuitem"
						type="button">
						Manage configurations…
					</button>
				</div>
			</PopoverContent>
		</Popover>
	)
}

export default memo(ModelEffortPill)
