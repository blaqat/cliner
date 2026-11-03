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

/** The filled send segment(s): the mode's color, as the switch's thumb is. */
const SEND_CLASS = "bg-transparent text-inherit hover:bg-(--vscode-toolbar-hoverBackground) disabled:hover:bg-transparent"

/** Each mode's fill and text on the switch's thumb and the send part. */
const MODE_FILL: Record<Mode, { background: string; color: string }> = {
	plan: { background: PLAN_MODE_COLOR, color: PLAN_MODE_FOREGROUND },
	act: { background: "var(--vscode-button-background)", color: "var(--vscode-button-foreground)" },
}

const SWITCH_CLASS =
	"relative flex h-5 shrink-0 cursor-pointer select-none items-center overflow-hidden rounded-full border border-solid border-input-border bg-transparent p-0 text-[11px] leading-none font-medium focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1 focus-visible:outline-(--vscode-focusBorder)"

/** A label trimmed to its capitals, so centering it centers the letters (a line box sits them low). */
const LABEL_TRIM_CLASS = "block [text-box:trim-both_cap_alphabetic]"

const SLIDE_CLASS =
	"transition-transform duration-200 ease-out motion-reduce:transition-none [.vscode-reduce-motion_&]:transition-none"

const MODES: readonly Mode[] = ["plan", "act"]

interface ModeSwitchProps {
	mode: Mode
	onToggle: () => void
	/** "⌘⇧A" / "Ctrl+Shift+A". */
	keys: string
	/** The tightest row: only the current mode's name, on a thumb that slides across a short track. */
	compact?: boolean
}

/**
 * `( Ask | Act )`: a sliding switch, as upstream's Plan/Act one was. The thumb sits under the current
 * mode in that mode's color; a click anywhere on it (or the shortcut) flips to the other mode.
 */
export function ModeSwitch({ mode, onToggle, keys, compact = false }: ModeSwitchProps) {
	const plan = mode === "plan"
	const other: Mode = plan ? "act" : "plan"
	const fill = MODE_FILL[mode]
	return (
		<button
			aria-checked={!plan}
			aria-label={`Mode: ${MODE_LABELS[mode]}. Switch to ${MODE_LABELS[other]} (${keys})`}
			className={cn(SWITCH_CLASS, compact ? "w-[3.3em]" : "grid grid-cols-2")}
			data-compact={compact || undefined}
			data-mode={mode}
			data-testid="mode-switch"
			onClick={onToggle}
			role="switch"
			title={`Switch to ${MODE_LABELS[other]} (${keys})\n${MODE_DESCRIPTIONS[mode]}`}
			type="button">
			{compact ? (
				<span
					aria-hidden
					className={cn(
						"absolute inset-y-0 left-0 flex w-[2.4em] items-center justify-center rounded-full",
						SLIDE_CLASS,
					)}
					data-testid="mode-switch-thumb"
					style={{ ...fill, transform: plan ? "translateX(0)" : "translateX(0.9em)" }}>
					<span className={LABEL_TRIM_CLASS}>{MODE_LABELS[mode]}</span>
				</span>
			) : (
				<>
					<span
						aria-hidden
						className={cn("absolute inset-y-0 left-0 w-1/2 rounded-full", SLIDE_CLASS)}
						data-testid="mode-switch-thumb"
						style={{ background: fill.background, transform: plan ? "translateX(0)" : "translateX(100%)" }}
					/>
					{MODES.map((option) => (
						<span
							aria-hidden
							className={cn(
								"relative flex h-full items-center justify-center px-1.5 transition-colors duration-200 motion-reduce:transition-none",
								option !== mode && "text-description hover:text-foreground",
							)}
							data-active={option === mode || undefined}
							key={option}
							style={option === mode ? { color: fill.color } : undefined}>
							<span className={LABEL_TRIM_CLASS}>{MODE_LABELS[option]}</span>
						</span>
					))}
				</>
			)}
		</button>
	)
}

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
	/** The tightest row: the mode switch shows only the current mode. */
	compactMode?: boolean
	/** While the agent runs, the send part splits into steer and interject. */
	running?: {
		enterSendsAs: EnterSendsAs
		modKey: string
		onSteer: () => void
		onInterject: () => void
	}
}

/**
 * `( Ask | Act ) [ ➤ ]`: the sliding mode switch (Ask ↔ Act, also the shortcut), then the filled
 * send part in the mode's color. While running, the send part becomes steer and interject (the one
 * Enter does is highlighted) and the switch stays one click.
 */
const SendSplitButton = ({
	mode,
	disabled,
	onSend,
	onPickMode,
	flash = false,
	toggleKeys,
	sendTitle,
	compactMode = false,
	running,
}: SendSplitButtonProps) => {
	const label = MODE_LABELS[mode]
	const plan = mode === "plan"
	const other: Mode = plan ? "act" : "plan"
	const keys = shortcutGlyphs(toggleKeys)
	const keyFor = (kind: EnterSendsAs) => (running && kind === running.enterSendsAs ? "Enter" : `${running?.modKey}+Enter`)

	return (
		<div className="flex shrink-0 items-center gap-1" data-testid="mode-and-send">
			<ModeSwitch compact={compactMode} keys={keys} mode={mode} onToggle={() => onPickMode(other)} />
			<Shell
				$flash={flash}
				className="flex h-5.5 shrink-0 items-stretch overflow-hidden rounded-xs"
				data-mode={mode}
				data-testid="send-split"
				style={MODE_FILL[mode]}>
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
		</div>
	)
}

export default memo(SendSplitButton)
