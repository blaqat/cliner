import {
	matchingChoices,
	parseTypedOptions,
	SCRIPT_APPROVAL_LABELS,
	type ScriptOption,
	setTypedOption,
	typedFocus,
	typedOptionsHint,
} from "@shared/scripts"
import type React from "react"
import { LinkButton } from "@/components/common/LinkButton"
import type { ScriptEntry } from "@/hooks/useScripts"
import { cn } from "@/lib/utils"

interface ScriptHelperProps {
	script: ScriptEntry
	/** The typed options (the first line after `/script-name`). */
	optionsText: string
	/** Replaces the typed options; the composer keeps the focus. */
	onChange: (next: string) => void
}

function describeKind(option: ScriptOption): string {
	return option.choicesFrom === "mmrc" ? `${option.kind} · from .mmrc` : option.kind
}

/**
 * Discord-style helper above the composer: every option of the script with its kind, required or
 * optional badge, description and choices. Options are typed inline (`module:api watch`); the
 * strip highlights what is being typed and filters to the matching options and choices.
 */
const ScriptHelper: React.FC<ScriptHelperProps> = ({ script, optionsText, onChange }) => {
	const options = script.options
	const parsed = parseTypedOptions(optionsText, options)
	const focus = typedFocus(optionsText, options)
	const typingName = !!parsed.partial && !parsed.partial.hasColon && focus.nameMatches.length > 0
	const visible = typingName ? focus.nameMatches : options
	// What blocks send right now. A bare word that is still the start of an option name gets a Tab hint
	// instead of an "unknown option" error.
	const sendHint = typedOptionsHint(optionsText, options)
	const completing = typingName && parsed.issues.length === 0 && sendHint?.startsWith("Unknown option") === true
	const status = completing
		? { text: `Tab completes ${focus.nameMatches[0].name}`, tone: "info" as const }
		: sendHint
			? { text: sendHint, tone: "error" as const }
			: { text: "Ready. Enter runs it.", tone: "ok" as const }
	const filledNames = new Set(Object.keys(parsed.values))

	return (
		<div
			aria-label={`Options for ${script.name}`}
			className="mx-3.5 -mb-1 max-h-72 overflow-y-auto rounded-t-xs border border-b-0 border-editor-group-border bg-(--vscode-editorWidget-background) px-2.5 py-2 text-xs"
			data-testid="script-helper"
			role="group">
			<div className="flex items-baseline gap-2">
				<span aria-hidden className="codicon codicon-play text-[11px]! text-description" />
				<span className="ph-no-capture font-mono font-semibold">{script.name}</span>
				<span className="min-w-0 flex-1 truncate text-description">{script.description}</span>
				{script.approval !== "" && (
					<span className="shrink-0 text-[11px] text-description">{SCRIPT_APPROVAL_LABELS[script.approval]}</span>
				)}
			</div>
			{options.length === 0 && <div className="mt-1.5 text-description">No options. Press Enter to run it.</div>}
			{visible.map((option) => {
				const value = parsed.values[option.name]
				const isSet = value !== undefined
				const isCurrent = focus.option?.name === option.name || (typingName && focus.nameMatches.includes(option))
				const missing = option.required && !isSet && option.default === undefined
				const choices =
					isCurrent && option.kind === "choice" && focus.option?.name === option.name
						? matchingChoices(option, focus.partial)
						: []
				return (
					<div
						className={cn(
							"mt-1.5 rounded-xs border border-solid px-2 py-1",
							isCurrent
								? "border-(--vscode-focusBorder) bg-list-hover"
								: isSet
									? "border-success/40"
									: missing
										? "border-error/40"
										: "border-editor-group-border",
						)}
						data-testid={`script-option-${option.name}`}
						key={option.name}>
						<div className="flex items-center gap-1.5">
							<span className="font-mono font-semibold">{option.name}</span>
							<span
								className={cn(
									"rounded-full border border-solid px-1.5 text-[10px] leading-4",
									option.required
										? "border-error/50 text-error"
										: "border-editor-group-border text-description",
								)}>
								{option.required ? "required" : "optional"}
							</span>
							<span className="flex-1" />
							<span className="text-description">{describeKind(option)}</span>
						</div>
						<div className="flex items-center gap-2">
							<span className="min-w-0 flex-1 truncate text-description">{option.description}</span>
							{isSet && (
								<span className="flex shrink-0 items-center gap-0.5 text-success">
									<span aria-hidden className="codicon codicon-check text-[11px]!" />
									<span className="ph-no-capture">{value === true ? "on" : String(value)}</span>
								</span>
							)}
							{!isSet && option.default !== undefined && (
								<span className="shrink-0 text-description">default {String(option.default)}</span>
							)}
						</div>
						{choices.length > 0 && (
							<div className="mt-1 flex flex-wrap gap-1">
								{choices.map((choice) => (
									<button
										className={cn(
											"cursor-pointer rounded-full border border-solid px-2 text-[11px] leading-4",
											value === choice
												? "border-(--vscode-focusBorder) bg-button-background text-button-foreground"
												: "border-editor-group-border bg-transparent text-foreground hover:bg-list-hover",
										)}
										data-testid={`script-choice-${option.name}-${choice}`}
										key={choice}
										onClick={() => onChange(setTypedOption(optionsText, options, option.name, choice))}
										onMouseDown={(event) => event.preventDefault()}
										type="button">
										{choice}
									</button>
								))}
							</div>
						)}
						{!isSet && !isCurrent && (
							<LinkButton
								className="mt-0.5"
								onClick={() =>
									onChange(
										setTypedOption(optionsText, options, option.name, option.kind === "flag" ? true : ""),
									)
								}
								onMouseDown={(event) => event.preventDefault()}>
								{option.kind === "flag" ? "add flag" : option.kind === "text" ? "type a value" : "pick"}
							</LinkButton>
						)}
					</div>
				)
			})}
			<div
				className={cn(
					"mt-1.5",
					status.tone === "error" && "text-error",
					status.tone === "ok" && "text-success",
					status.tone === "info" && "text-description",
				)}
				data-testid="script-helper-status"
				role="status">
				{status.text}
				{status.tone !== "info" && options.length > 0 && filledNames.size < options.length && (
					<span className="ml-2 text-description">Tab completes</span>
				)}
			</div>
		</div>
	)
}

export default ScriptHelper
