import { automationArgsAsOptions } from "@shared/automations"
import { completeTypedOptions, parseTypedOptions, type ScriptOption, typedOptionsHint } from "@shared/scripts"
import type { AutomationEntry } from "@/hooks/useAutomations"

type RunnableAutomation = AutomationEntry & { definition: NonNullable<AutomationEntry["definition"]> }

/** A composer draft that starts with `/automation-name ` followed by typed arguments. */
export interface AutomationInput {
	automation: RunnableAutomation
	/** The arguments as typed options, so the script parser, Tab completion and choices apply. */
	options: ScriptOption[]
	/** Text up to the arguments, e.g. "/ticket-to-pr ". */
	prefix: string
	/** The typed arguments: the rest of the first line. */
	optionsText: string
	/** Everything after the first line. Automations take no note, so it has to be empty to run. */
	suffix: string
}

/**
 * Finds the automation a draft starts. Needs a space after the name, so a name still being typed in
 * the slash menu doesn't open the start form.
 */
export function matchAutomationInput(text: string, automations: readonly RunnableAutomation[]): AutomationInput | null {
	const match = /^(\s*\/([a-z0-9][a-z0-9_-]*)[ \t]+)([^\n]*)(\n[\s\S]*)?$/.exec(text)
	if (!match) return null
	const automation = automations.find((candidate) => candidate.name === match[2])
	if (!automation) return null
	return {
		automation,
		options: automationArgsAsOptions(automation.definition.arguments),
		prefix: match[1],
		optionsText: match[3],
		suffix: match[4] ?? "",
	}
}

/** Argument values the draft gives, or the one reason it can't run yet. */
export function automationInputValues(input: AutomationInput): { values: Record<string, string> } | { reason: string } {
	if (input.suffix.trim()) return { reason: "Automations take no note. Put it in an argument, or remove the extra lines." }
	const hint = typedOptionsHint(input.optionsText, input.options)
	if (hint) return { reason: hint }
	const parsed = parseTypedOptions(input.optionsText, input.options, { final: true })
	return {
		values: Object.fromEntries(Object.entries(parsed.values).map(([name, value]) => [name, String(value)])),
	}
}

/** Tab inside the arguments: completes what's being typed, then jumps to the next missing required one. */
export function completeAutomationInput(input: AutomationInput): { text: string; cursor: number } | null {
	const next = completeTypedOptions(input.optionsText, input.options)
	if (next === input.optionsText) return null
	return { text: `${input.prefix}${next}${input.suffix}`, cursor: input.prefix.length + next.length }
}
