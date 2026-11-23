import type { AutomationArgument } from "@shared/automations"
import type React from "react"
import { forwardRef, useId, useImperativeHandle, useRef, useState } from "react"
import { cn } from "@/lib/utils"
import { type AutomationDraft, argumentProblem, matchingChoices, missingArguments } from "./automationInput"

/** Where to put the caret: a field by argument name, the command chip, or the first field still to fill. */
export type ArgsFocusTarget = "command" | "start" | "last" | { name: string; at?: "start" | "end" }

export interface AutomationArgsRowHandle {
	focus: (target: ArgsFocusTarget) => void
}

interface AutomationArgsRowProps {
	draft: AutomationDraft
	onChange: (values: Record<string, string>) => void
	/** Backspace on the command chip: back to plain text. */
	onRemove: () => void
	/** Past the last field: the context box under the chips. */
	onFocusContext: () => void
	/** Enter with every required argument filled. */
	onSubmit: () => void
	/** Values offered under a ticket or branch field (the task's tickets, the current branch). */
	suggestionsFor: (arg: AutomationArgument) => string[]
	/** The argument being edited, for the start form above. */
	onFocusArg?: (name: string | undefined) => void
	/** Run was pressed with something missing: mark it. */
	showMissing?: boolean
}

const PLACEHOLDERS: Record<AutomationArgument["kind"], string> = {
	text: "text",
	ticket: "key or URL",
	branch: "branch",
	choice: "pick one",
}

/** Kinds whose values never hold a space: Space moves to the next field, like Tab. */
const ONE_WORD = new Set<AutomationArgument["kind"]>(["ticket", "branch", "choice"])

/**
 * The arguments of an automation draft as chips in the composer, Discord style: `/name`, then one chip
 * per argument with its own field, so what goes into which argument is always clear. Tab and Shift+Tab
 * move between fields, Enter runs, Backspace at the start of a field steps back. A choice field picks
 * with the arrow keys or the options under the chips; ticket and branch fields offer suggestions there.
 */
export const AutomationArgsRow = forwardRef<AutomationArgsRowHandle, AutomationArgsRowProps>(
	({ draft, onChange, onRemove, onFocusContext, onSubmit, suggestionsFor, onFocusArg, showMissing }, ref) => {
		const args = draft.automation.definition.arguments
		const inputs = useRef(new Map<string, HTMLInputElement>())
		const commandRef = useRef<HTMLButtonElement>(null)
		const [focused, setFocused] = useState<string>()
		const helpId = useId()
		const missing = new Set(missingArguments(draft).map((arg) => arg.name))

		const focusField = (name: string, at: "start" | "end" = "end") => {
			const input = inputs.current.get(name)
			if (!input) return
			input.focus()
			const position = at === "start" ? 0 : input.value.length
			input.setSelectionRange(position, position)
		}
		const focus = (target: ArgsFocusTarget) => {
			if (target === "command") return commandRef.current?.focus()
			if (target === "start") {
				const next =
					args.find((arg) => missing.has(arg.name)) ?? args.find((arg) => !draft.values[arg.name] && !arg.default)
				return next ? focusField(next.name) : onFocusContext()
			}
			if (target === "last") {
				const last = args.at(-1)
				return last ? focusField(last.name) : commandRef.current?.focus()
			}
			focusField(target.name, target.at)
		}
		useImperativeHandle(ref, () => ({ focus }))

		const set = (name: string, value: string) => {
			const next = { ...draft.values }
			if (value) next[name] = value
			else delete next[name]
			onChange(next)
		}
		const step = (index: number, direction: 1 | -1) => {
			const next = args[index + direction]
			if (next) focusField(next.name)
			else if (direction === 1) onFocusContext()
			else commandRef.current?.focus()
		}
		/** A choice typed in part becomes the first choice it starts. */
		const settle = (arg: AutomationArgument) => {
			const value = draft.values[arg.name]
			if (arg.kind !== "choice" || !value || arg.choices?.includes(value)) return
			const [match] = matchingChoices(arg, value)
			if (match) set(arg.name, match)
		}

		const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>, arg: AutomationArgument, index: number) => {
			if (event.nativeEvent.isComposing) return
			const input = event.currentTarget
			const atStart = input.selectionStart === 0 && input.selectionEnd === 0
			if (event.key === "Tab" && !event.metaKey && !event.ctrlKey && !event.altKey) {
				event.preventDefault()
				settle(arg)
				step(index, event.shiftKey ? -1 : 1)
			} else if (event.key === " " && ONE_WORD.has(arg.kind) && !event.shiftKey) {
				event.preventDefault()
				settle(arg)
				step(index, 1)
			} else if (event.key === "Enter" && event.shiftKey) {
				event.preventDefault()
				settle(arg)
				onFocusContext()
			} else if (event.key === "Enter") {
				event.preventDefault()
				settle(arg)
				const first = args.find((candidate) => missing.has(candidate.name) && candidate.name !== arg.name)
				if (missing.has(arg.name) && !input.value) focusField(arg.name)
				else if (first) focusField(first.name)
				else onSubmit()
			} else if (event.key === "Backspace" && atStart) {
				event.preventDefault()
				step(index, -1)
			} else if (event.key === "ArrowLeft" && atStart) {
				event.preventDefault()
				step(index, -1)
			} else if (event.key === "ArrowRight" && input.selectionStart === input.value.length && index < args.length - 1) {
				event.preventDefault()
				focusField(args[index + 1].name, "start")
			} else if ((event.key === "ArrowDown" || event.key === "ArrowUp") && arg.kind === "choice") {
				event.preventDefault()
				const choices = arg.choices ?? []
				if (!choices.length) return
				const current = choices.indexOf(draft.values[arg.name] ?? arg.default ?? "")
				const next =
					current < 0
						? event.key === "ArrowDown"
							? 0
							: choices.length - 1
						: (current + (event.key === "ArrowDown" ? 1 : -1) + choices.length) % choices.length
				set(arg.name, choices[next])
			}
		}

		const focusedArg = args.find((arg) => arg.name === focused)
		const focusedValue = focusedArg ? (draft.values[focusedArg.name] ?? "") : ""
		const offered = focusedArg
			? focusedArg.kind === "choice"
				? (focusedArg.choices ?? [])
				: suggestionsFor(focusedArg).filter((value) => value !== focusedValue)
			: []

		return (
			<div className="px-2 pt-1.5" data-testid="automation-args-row">
				<div
					aria-label={`Arguments for /${draft.automation.name}`}
					className="flex flex-wrap items-center gap-1"
					role="group">
					<button
						aria-label={`Automation /${draft.automation.name}. Backspace removes it.`}
						className="inline-flex max-w-full shrink-0 cursor-default items-center gap-1 rounded-xs border-0 bg-badge-background px-1.5 py-0.5 font-mono text-[12px] leading-4 text-badge-foreground focus-visible:outline focus-visible:outline-1 focus-visible:outline-(--vscode-focusBorder)"
						data-testid="automation-command-chip"
						onKeyDown={(event) => {
							if (event.key === "Backspace" || event.key === "Delete") {
								event.preventDefault()
								onRemove()
							} else if (event.key === "ArrowRight" || event.key === "Enter") {
								event.preventDefault()
								focus("start")
							}
						}}
						ref={commandRef}
						title="Backspace removes the automation"
						type="button">
						<span aria-hidden className="codicon codicon-run-all text-[11px]!" />
						<span className="truncate">/{draft.automation.name}</span>
					</button>
					{args.map((arg, index) => {
						const value = draft.values[arg.name] ?? ""
						const problem = argumentProblem(arg, value)
						const isMissing = showMissing && missing.has(arg.name)
						return (
							<label
								className={cn(
									"inline-flex min-w-0 max-w-full cursor-text items-center gap-1 rounded-xs border border-solid py-px pr-1 pl-1.5 text-[12px] leading-4",
									"bg-input-background focus-within:border-(--vscode-focusBorder)",
									problem || isMissing
										? "border-error"
										: value
											? "border-editor-group-border"
											: "border-input-border",
								)}
								data-testid={`automation-chip-${arg.name}`}
								key={arg.name}>
								<span className="shrink-0 text-description">
									{arg.name}
									{arg.required && (
										<span aria-hidden className="text-error" title="Required">
											*
										</span>
									)}
								</span>
								<input
									aria-describedby={focused === arg.name ? helpId : undefined}
									aria-invalid={!!problem || isMissing || undefined}
									aria-label={`${arg.name}${arg.required ? ", required" : ""}${arg.description ? `: ${arg.description}` : ""}`}
									aria-required={arg.required || undefined}
									autoComplete="off"
									className="ph-no-capture min-w-[3ch] max-w-full border-0 bg-transparent p-0 font-[inherit] text-[12px] text-input-foreground outline-none [field-sizing:content] placeholder:text-input-placeholder"
									data-testid={`automation-field-${arg.name}`}
									onBlur={() => {
										settle(arg)
										setFocused((current) => (current === arg.name ? undefined : current))
										onFocusArg?.(undefined)
									}}
									onChange={(event) => set(arg.name, event.target.value)}
									onFocus={() => {
										setFocused(arg.name)
										onFocusArg?.(arg.name)
									}}
									onKeyDown={(event) => onKeyDown(event, arg, index)}
									placeholder={arg.default || PLACEHOLDERS[arg.kind]}
									ref={(element) => {
										if (element) inputs.current.set(arg.name, element)
										else inputs.current.delete(arg.name)
									}}
									spellCheck={arg.kind === "text"}
									value={value}
								/>
							</label>
						)
					})}
				</div>
				{focusedArg && (
					<div
						className="mt-1 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] text-description"
						data-testid="automation-arg-help"
						id={helpId}>
						<span className="min-w-0">
							<span className="font-medium text-foreground">{focusedArg.name}</span>
							{focusedArg.required ? " · required" : " · optional"}
							{focusedArg.description ? ` · ${focusedArg.description}` : ""}
							{focusedArg.default ? ` · default ${focusedArg.default}` : ""}
						</span>
						{offered.length > 0 && (
							<span
								aria-label={focusedArg.kind === "choice" ? `Choices for ${focusedArg.name}` : "Suggestions"}
								className="flex flex-wrap items-center gap-1"
								role="listbox">
								{offered.map((option) => {
									const selected =
										option === (focusedValue || (focusedArg.kind === "choice" ? focusedArg.default : ""))
									return (
										<button
											aria-selected={selected}
											className={cn(
												"cursor-pointer rounded-full border border-solid px-2 text-[11px] leading-4 hover:bg-list-hover",
												selected
													? "border-(--vscode-focusBorder) bg-list-hover text-foreground"
													: "border-editor-group-border bg-transparent text-foreground",
											)}
											data-testid={`automation-option-${focusedArg.name}-${option}`}
											key={option}
											onClick={() => {
												set(focusedArg.name, option)
												const index = args.indexOf(focusedArg)
												step(index, 1)
											}}
											onMouseDown={(event) => event.preventDefault()}
											role="option"
											type="button">
											{focusedArg.kind === "choice" ? option : `Use ${option}`}
										</button>
									)
								})}
							</span>
						)}
						{focusedArg.kind === "choice" && <span>↑↓ to pick · Tab next</span>}
						{focusedArg.kind !== "choice" && <span>Tab next · Enter runs</span>}
					</div>
				)}
			</div>
		)
	},
)
AutomationArgsRow.displayName = "AutomationArgsRow"
