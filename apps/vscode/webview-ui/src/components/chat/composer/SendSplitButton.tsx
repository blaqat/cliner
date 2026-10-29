import type { Mode } from "@shared/storage/types"
import { memo } from "react"
import styled, { css, keyframes } from "styled-components"
import { cn } from "@/lib/utils"
import type { EnterSendsAs } from "../chat-view/utils/composerKeys"

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
	"flex h-full cursor-pointer items-center gap-1 border-0 px-1.5 text-xs focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-2 focus-visible:outline-(--vscode-focusBorder) disabled:cursor-not-allowed disabled:opacity-50"

/** The quiet toggle segment: secondary colors, so it reads as a switch beside the filled send. */
const MODE_CLASS =
	"bg-button-secondary-background text-button-secondary-foreground hover:bg-button-secondary-background-hover pl-2 pr-1.5 font-medium"

/** The filled send segment(s): the mode's color, as the old switch's slider was. */
const SEND_CLASS = "bg-transparent text-inherit hover:bg-(--vscode-toolbar-hoverBackground) disabled:hover:bg-transparent"

/** "⌘+Shift+A" → "⌘⇧A" on macOS; "Ctrl+Shift+A" stays as is. */
export function shortcutGlyphs(keys: string): string {
	if (!keys.startsWith("⌘")) return keys
	return keys
		.replace(/\+?Shift\+?/g, "⇧")
		.replace(/\+?Alt\+?/g, "⌥")
		.replace(/\+?Ctrl\+?/g, "⌃")
		.replace(/\+/g, "")
}

export interface SendSplitButtonProps {
	mode: Mode
	/** Sending is blocked (empty draft, script options missing, ...); the mode toggle stays usable. */
	disabled: boolean
	onSend: () => void
	onPickMode: (mode: Mode) => void
	/** Flash after a mode change from `/ask`, `/act` or the shortcut. */
	flash?: boolean
	/** "⌘+Shift+A" / "Ctrl+Shift+A". */
	toggleKeys: string
	/** What the send part does, with its keys ("Send (Enter) · Aside (Alt+Enter)"). */
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
 * `[ Act ⇄ | ➤ ]`: the mode's name is a one-click toggle (Act ↔ Ask, also the shortcut), styled as
 * a quiet secondary segment; the filled segment with the send icon sends. Ask fills the send part
 * with the Ask color. While running, the send part becomes steer and interject (the one Enter does
 * is highlighted) and the mode toggle stays one click.
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
	const label = MODE_LABELS[mode]
	const plan = mode === "plan"
	const other: Mode = plan ? "act" : "plan"
	const keys = shortcutGlyphs(toggleKeys)
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
			<button
				aria-label={`Mode: ${label}. Switch to ${MODE_LABELS[other]} (${keys})`}
				className={cn(PART_CLASS, MODE_CLASS)}
				data-testid="mode-switch"
				onClick={() => onPickMode(other)}
				title={`Switch to ${MODE_LABELS[other]} (${keys})\n${MODE_DESCRIPTIONS[mode]}`}
				type="button">
				{label}
				<span aria-hidden className="codicon codicon-arrow-swap text-[10px]! opacity-60" />
			</button>
			{running ? (
				(
					[
						{
							kind: "steer" as const,
							label: "Steer",
							tooltip: `Steer (${keyFor("steer")}): queue this message for after the current turn`,
							icon: "send",
							onClick: running.onSteer,
						},
						{
							kind: "interject" as const,
							label: "Interject",
							tooltip: `Interject (${keyFor("interject")}): stop the current turn and send now`,
							icon: "zap",
							onClick: running.onInterject,
						},
					] as const
				).map((button) => (
					<button
						aria-label={button.label}
						className={cn(
							PART_CLASS,
							SEND_CLASS,
							"px-1.5",
							button.kind !== running.enterSendsAs && "opacity-70 hover:opacity-100",
						)}
						data-default={button.kind === running.enterSendsAs ? "true" : undefined}
						data-testid={`${button.kind}-button`}
						disabled={disabled}
						key={button.kind}
						onClick={button.onClick}
						title={button.tooltip}
						type="button">
						<span aria-hidden className={`codicon codicon-${button.icon} text-[13px]!`} />
					</button>
				))
			) : (
				<button
					aria-label={`Send (${label})`}
					className={cn(PART_CLASS, SEND_CLASS, "px-2", { disabled })}
					data-testid="send-button"
					disabled={disabled}
					onClick={onSend}
					title={`${sendTitle}\n${MODE_DESCRIPTIONS[mode]}`}
					type="button">
					<span aria-hidden className="codicon codicon-send text-[13px]!" />
				</button>
			)}
		</Shell>
	)
}

export default memo(SendSplitButton)
