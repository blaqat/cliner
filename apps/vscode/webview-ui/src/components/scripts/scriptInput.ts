import { completeTypedOptions, isTypedOptionsComplete, parseTypedOptions, type ScriptValues } from "@shared/scripts"
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

/**
 * The script run a draft asks for: the script and the option values the helper strip shows.
 * Undefined unless the draft is a complete, valid invocation, the same one the host expands.
 */
export function scriptRunOf(text: string, scripts: readonly ScriptEntry[]): { name: string; values: ScriptValues } | undefined {
	const input = matchScriptInput(text, scripts)
	if (!input) return undefined
	const parsed = parseTypedOptions(input.optionsText, input.script.options, { final: true })
	if (parsed.issues.length > 0 || parsed.missing.length > 0) return undefined
	return { name: input.script.name, values: parsed.values }
}
