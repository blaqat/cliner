import type { Mode } from "@shared/storage/types"
import { ArrowUpIcon, SendHorizontalIcon, ZapIcon } from "lucide-react"
import { memo, useState } from "react"
import styled, { css, keyframes } from "styled-components"
import { MENU_ICON_CLASS, MENU_SEPARATOR_CLASS } from "@/components/common/menuStyles"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import type { EnterSendsAs } from "../chat-view/utils/composerKeys"
import { handleMenuKeyDown, MENU_ROW_CLASS } from "./menuKeyboard"

/** Ask mode's color: the textarea's focus outline and the Send button's fill. */
export const PLAN_MODE_COLOR = "var(--vscode-activityWarningBadge-background)"
const PLAN_MODE_FOREGROUND = "var(--vscode-activityWarningBadge-foreground)"

export const MODE_DESCRIPTIONS: Record<Mode, string> = {
	act: "In Act mode, Cline will complete the task immediately",
	plan: "In Ask mode, Cline will answer questions and explore the codebase",
}

const MODE_LABELS: Record<Mode, string> = { act: "Act", plan: "Ask" }

const flash = keyframes`
	0% { box-shadow: 0 0 0 0 var(--vscode-focusBorder); }
	100% { box-shadow: 0 0 0 7px transparent; }
`

/** The split button's shell; a `/ask` or `/act` command (or the shortcut) flashes it. */
const Shell = styled.div.withConfig({ shouldForwardProp: (prop) => prop !== "$flash" })<{ $flash?: boolean }>`
	animation: ${(props) => (props.$flash ? css`${flash} 0.7s ease-out` : "none")};
	@media (prefers-reduced-motion: reduce) {
		animation: none;
	}
	/* VS Code's workbench.reduceMotion lands as a body class, not a media query. */
	body.vscode-reduce-motion & {
		animation: none;
	}
`

const PART_CLASS =
	"flex h-full cursor-pointer items-center gap-1 border-0 bg-transparent px-1.5 text-xs text-inherit hover:bg-(--vscode-toolbar-hoverBackground) focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-2 focus-visible:outline-(--vscode-focusBorder) disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"

export interface SendSplitButtonProps {
	mode: Mode
	/** Sending is blocked (empty draft, script options missing, ...); the mode part stays usable. */
	disabled: boolean
	onSend: () => void
	onPickMode: (mode: Mode) => void
	/** Flash after a mode change from `/ask`, `/act` or the shortcut. */
	flash?: boolean
	/** "⌘+Shift+A" / "Ctrl+Shift+A". */
	toggleKeys: string
	/** What the main part does, with its keys ("Send (Enter) · Aside (Alt+Enter)"). */
	sendTitle: string
	/** While the agent runs, the send part splits into steer and interject. */
	running?: {
		enterSendsAs: EnterSendsAs
		modKey: string
		onSteer: () => void
		onInterject: () => void
	}
}

/**
 * Send carries the mode: "Act ↑" / "Ask ↑" sends, the small ⌄ opens a menu to switch Ask/Act (with
 * the toggle shortcut). The fill follows the mode, as the old switch's slider did. While running,
 * the send part becomes steer and interject (the one Enter does is highlighted) and the mode part
 * keeps the mode's name.
 */
const SendSplitButton = ({
	mode,
	disabled,
	onSend,
	onPickMode,
	flash = false,
	toggleKeys,
	sendTitle,
	running,
}: SendSplitButtonProps) => {
	const [open, setOpen] = useState(false)
	const label = MODE_LABELS[mode]
	const plan = mode === "plan"
	const keyFor = (kind: EnterSendsAs) => (running && kind === running.enterSendsAs ? "Enter" : `${running?.modKey}+Enter`)

	return (
		<Shell
			$flash={flash}
			className="flex h-5.5 shrink-0 items-stretch overflow-hidden rounded-xs"
			data-mode={mode}
			data-testid="send-split"
			style={{
				background: plan ? PLAN_MODE_COLOR : "var(--vscode-button-background)",
				color: plan ? PLAN_MODE_FOREGROUND : "var(--vscode-button-foreground)",
			}}>
			{running ? (
				(
					[
						{
							kind: "steer" as const,
							label: "Steer",
							tooltip: `Steer (${keyFor("steer")}): queue this message for after the current turn`,
							Icon: SendHorizontalIcon,
							onClick: running.onSteer,
						},
						{
							kind: "interject" as const,
							label: "Interject",
							tooltip: `Interject (${keyFor("interject")}): stop the current turn and send now`,
							Icon: ZapIcon,
							onClick: running.onInterject,
						},
					] as const
				).map((button) => (
					<button
						aria-label={button.label}
						className={cn(PART_CLASS, "px-1", button.kind !== running.enterSendsAs && "opacity-70 hover:opacity-100")}
						data-default={button.kind === running.enterSendsAs ? "true" : undefined}
						data-testid={`${button.kind}-button`}
						disabled={disabled}
						key={button.kind}
						onClick={button.onClick}
						title={button.tooltip}
						type="button">
						<button.Icon size={13} />
					</button>
				))
			) : (
				<button
					aria-label={`${label}: send`}
					className={cn(PART_CLASS, "pl-2 font-medium", { disabled })}
					data-testid="send-button"
					disabled={disabled}
					onClick={onSend}
					title={`${sendTitle}\n${MODE_DESCRIPTIONS[mode]}`}
					type="button">
					{label}
					<ArrowUpIcon size={12} strokeWidth={2.5} />
				</button>
			)}
			<Popover onOpenChange={setOpen} open={open}>
				<PopoverTrigger asChild>
					<button
						aria-label={`Mode: ${label}. Switch Ask/Act (${toggleKeys})`}
						className={cn(
							PART_CLASS,
							"border-l border-solid border-y-0 border-r-0 border-current/25 px-1",
							open && "bg-(--vscode-toolbar-hoverBackground)",
						)}
						data-testid="mode-switch"
						title={`${MODE_DESCRIPTIONS[mode]}\nSwitch Ask/Act (${toggleKeys})`}
						type="button">
						{running && <span className="pl-0.5 font-medium">{label}</span>}
						<span aria-hidden className="codicon codicon-chevron-down text-[11px]!" />
					</button>
				</PopoverTrigger>
				<PopoverContent align="end" className="menu-rise w-64 p-1" data-testid="mode-menu" side="top">
					<div aria-label="Mode" onKeyDown={handleMenuKeyDown} role="menu">
						{(["act", "plan"] as const).map((candidate) => (
							<button
								aria-checked={mode === candidate}
								autoFocus={mode === candidate}
								className={cn(MENU_ROW_CLASS, "h-auto items-start py-1")}
								data-testid={`mode-option-${candidate}`}
								key={candidate}
								onClick={() => {
									setOpen(false)
									if (candidate !== mode) onPickMode(candidate)
								}}
								role="menuitemradio"
								type="button">
								<span
									aria-hidden
									className={cn(
										MENU_ICON_CLASS,
										"mt-0.5",
										candidate === "act" ? "codicon-play" : "codicon-comment-discussion",
									)}
									style={candidate === "plan" ? { color: PLAN_MODE_COLOR } : undefined}
								/>
								<span className="flex min-w-0 flex-1 flex-col">
									<span>{MODE_LABELS[candidate]}</span>
									<span className="text-[11px] whitespace-normal text-description">
										{candidate === "act"
											? "Cline will complete the task immediately"
											: "Cline will answer questions and explore the codebase"}
									</span>
								</span>
								<span
									aria-hidden
									className={cn(MENU_ICON_CLASS, "mt-0.5 codicon-check", mode !== candidate && "invisible")}
								/>
							</button>
						))}
					</div>
					<div className={MENU_SEPARATOR_CLASS} />
					<div
						className="flex items-center justify-between px-2 pb-0.5 text-[11px] text-description"
						data-testid="mode-shortcut">
						Switch Ask/Act
						<kbd className="rounded-xs border border-solid border-menu-foreground/20 px-1 font-[inherit]">
							{toggleKeys}
						</kbd>
					</div>
				</PopoverContent>
			</Popover>
		</Shell>
	)
}

export default memo(SendSplitButton)
