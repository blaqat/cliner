import { completeTypedOptions, isTypedOptionsComplete } from "@shared/scripts"
import type { ScriptEntry } from "@/hooks/useScripts"

/** A composer draft that starts with `/script-name ` followed by typed options. */
export interface ScriptInput {
	script: ScriptEntry
	/** Text up to the options, e.g. "/test-module ". */
	prefix: string
	/** The typed options: the rest of the first line. */
	optionsText: string
	/** Everything after the first line: a note for the agent. */
	suffix: string
}

/**
 * Finds the script a draft is running. Needs a space after the name, so a script name still being
 * typed in the slash menu doesn't open the helper.
 */
export function matchScriptInput(text: string, scripts: readonly ScriptEntry[]): ScriptInput | null {
	const match = /^(\s*\/([a-z0-9][a-z0-9_-]*)[ \t]+)([^\n]*)(\n[\s\S]*)?$/.exec(text)
	if (!match) return null
	const script = scripts.find((candidate) => candidate.name === match[2])
	if (!script) return null
	return { script, prefix: match[1], optionsText: match[3], suffix: match[4] ?? "" }
}

/** Whether the draft can be sent: a script draft needs every required option and nothing invalid. */
export function isScriptInputSendable(input: ScriptInput | null): boolean {
	return !input || isTypedOptionsComplete(input.optionsText, input.script.options)
}

/**
 * Tab inside a script draft: completes the option or choice being typed, then jumps to the next
 * missing required option. Returns the new draft and cursor, or null when nothing changes.
 */
export function completeScriptInput(input: ScriptInput): { text: string; cursor: number } | null {
	const next = completeTypedOptions(input.optionsText, input.script.options)
	if (next === input.optionsText) return null
	return { text: `${input.prefix}${next}${input.suffix}`, cursor: input.prefix.length + next.length }
}
