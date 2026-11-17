/**
 * Scripts: saved, deterministic commands with declared options. This module is
 * shared by the extension (validation, `script` tool, message expansion) and the
 * webview (composer helper strip), so it must stay free of Node and DOM imports.
 */

export type ScriptApproval = "always_ask" | "ask_in_ask_mode" | "always_allow"
export const SCRIPT_APPROVALS: readonly ScriptApproval[] = ["always_ask", "ask_in_ask_mode", "always_allow"]
export const DEFAULT_SCRIPT_APPROVAL: ScriptApproval = "ask_in_ask_mode"

export type ScriptOptionKind = "flag" | "text" | "choice"
export const SCRIPT_OPTION_KINDS: readonly ScriptOptionKind[] = ["flag", "text", "choice"]

export interface ScriptOption {
	name: string
	kind: ScriptOptionKind
	required: boolean
	description: string
	/** Allowed values for `choice` options (already resolved when `choicesFrom` is set). */
	choices?: string[]
	/** Resolve `choices` from the workspace's `.mmrc` module list. */
	choicesFrom?: "mmrc"
	/** Permit leading-dash text arguments. Only enable when the command handles them safely. */
	allowDash?: boolean
	default?: string | boolean
}

/** Option values by option name: flags are `true`, text and choice are strings. */
export type ScriptValues = Record<string, string | boolean>

export const SCRIPT_NAME_REGEX = /^[a-z0-9][a-z0-9_-]{0,63}$/
export const SCRIPT_OPTION_NAME_REGEX = /^[a-z][a-z0-9_-]{0,47}$/

/** Longest text value accepted from the user or the agent. */
export const MAX_SCRIPT_TEXT_VALUE_LENGTH = 2000

// ---------------------------------------------------------------------------
// Typed options: `module:api watch filter:"slow tests"`
// ---------------------------------------------------------------------------

export interface TypedToken {
	/** Text of the token as typed, quotes included. */
	raw: string
	start: number
	end: number
	name: string
	hasColon: boolean
	/** Unquoted value after the colon; "" when absent. */
	value: string
	/** A quote was opened and not closed yet (the token is still being typed). */
	unclosed: boolean
}

export interface TypedIssue {
	/** Option the issue belongs to, when known. */
	option?: string
	message: string
}

export interface ParsedTypedOptions {
	tokens: TypedToken[]
	/** Values for declared options, defaults not applied. */
	values: ScriptValues
	issues: TypedIssue[]
	/** The token still being typed (text doesn't end in whitespace), if any. */
	partial: TypedToken | null
	/** Required options with no value and no default. */
	missing: ScriptOption[]
}

/** Splits typed option text into `name`, `name:value` and `name:"quoted value"` tokens. */
export function tokenizeTypedOptions(text: string): TypedToken[] {
	const tokens: TypedToken[] = []
	let index = 0
	while (index < text.length) {
		if (/\s/.test(text[index])) {
			index++
			continue
		}
		const start = index
		let name = ""
		while (index < text.length && !/\s/.test(text[index]) && text[index] !== ":") {
			name += text[index++]
		}
		let hasColon = false
		let value = ""
		let unclosed = false
		if (text[index] === ":") {
			hasColon = true
			index++
			const quote = text[index] === '"' || text[index] === "'" ? text[index] : null
			if (quote) {
				index++
				let closed = false
				while (index < text.length) {
					if (
						text[index] === "\\" &&
						index + 1 < text.length &&
						(text[index + 1] === quote || text[index + 1] === "\\")
					) {
						value += text[index + 1]
						index += 2
						continue
					}
					if (text[index] === quote) {
						closed = true
						index++
						break
					}
					value += text[index++]
				}
				unclosed = !closed
			} else {
				while (index < text.length && !/\s/.test(text[index])) {
					value += text[index++]
				}
			}
		}
		tokens.push({ raw: text.slice(start, index), start, end: index, name, hasColon, value, unclosed })
	}
	return tokens
}

function findOption(options: readonly ScriptOption[], name: string): ScriptOption | undefined {
	return options.find((option) => option.name === name)
}

function hasValue(option: ScriptOption, values: ScriptValues): boolean {
	const value = values[option.name]
	return option.kind === "flag" ? value === true : typeof value === "string" && value !== ""
}

/** Required options still without a value or default, in declaration order. */
export function missingRequiredOptions(options: readonly ScriptOption[], values: ScriptValues): ScriptOption[] {
	return options.filter((option) => option.required && !hasValue(option, values) && option.default === undefined)
}

/**
 * Parses typed option text against declared options.
 *
 * While the user is still typing, the last token (no trailing whitespace) is
 * `partial` and is not validated; pass `final: true` when sending, so every
 * token counts as committed.
 */
export function parseTypedOptions(
	text: string,
	options: readonly ScriptOption[],
	parseOptions: { final?: boolean } = {},
): ParsedTypedOptions {
	const tokens = tokenizeTypedOptions(text)
	const last = tokens[tokens.length - 1]
	// A token is still being typed when the text doesn't end in whitespace, or inside an open quote.
	const endsOpen = !!last && (!/\s$/.test(text) || last.unclosed)
	const partial = !parseOptions.final && endsOpen ? last : null
	const values: ScriptValues = {}
	const issues: TypedIssue[] = []
	for (const token of tokens) {
		if (token === partial) continue
		const option = findOption(options, token.name)
		if (!option) {
			issues.push({ message: `Unknown option "${token.name}"` })
			continue
		}
		if (token.unclosed) {
			issues.push({ option: option.name, message: `${option.name} has an unclosed quote` })
			continue
		}
		if (option.name in values) {
			issues.push({ option: option.name, message: `${option.name} is given twice` })
			continue
		}
		if (option.kind === "flag") {
			if (token.hasColon) issues.push({ option: option.name, message: `${option.name} is a flag; type it without a value` })
			else values[option.name] = true
			continue
		}
		if (!token.hasColon || token.value === "") {
			issues.push({ option: option.name, message: `${option.name} needs a value: ${option.name}:<value>` })
			continue
		}
		if (option.kind === "text" && token.value.startsWith("-") && !option.allowDash) {
			issues.push({ option: option.name, message: `${option.name} cannot start with '-'` })
			continue
		}
		if (token.value.length > MAX_SCRIPT_TEXT_VALUE_LENGTH) {
			issues.push({ option: option.name, message: `${option.name} is too long` })
			continue
		}
		if (option.kind === "choice" && option.choices && !option.choices.includes(token.value)) {
			issues.push({ option: option.name, message: `${option.name} must be one of ${option.choices.join(", ")}` })
			continue
		}
		values[option.name] = token.value
	}
	return { tokens, values, issues, partial, missing: missingRequiredOptions(options, values) }
}

/** True when typed text can be sent: nothing unknown or invalid, nothing required missing. */
export function isTypedOptionsComplete(text: string, options: readonly ScriptOption[]): boolean {
	const parsed = parseTypedOptions(text, options, { final: true })
	return parsed.issues.length === 0 && parsed.missing.length === 0
}

/** One short reason the text cannot be sent yet, for the helper strip. */
export function typedOptionsHint(text: string, options: readonly ScriptOption[]): string | null {
	const parsed = parseTypedOptions(text, options, { final: true })
	if (parsed.issues.length > 0) return parsed.issues[0].message
	if (parsed.missing.length > 0) return `Needs ${parsed.missing.map((option) => option.name).join(", ")}`
	return null
}

/** What the user is currently typing, for filtering the helper. */
export interface TypedFocus {
	/** Option whose value is being typed (`module:ap`). */
	option?: ScriptOption
	/** Text typed after the colon (or the bare word when no option matches yet). */
	partial: string
	/** Options whose names start with a bare word being typed. */
	nameMatches: ScriptOption[]
}

export function typedFocus(text: string, options: readonly ScriptOption[]): TypedFocus {
	const { partial } = parseTypedOptions(text, options)
	if (!partial) return { partial: "", nameMatches: [] }
	if (partial.hasColon) {
		return { option: findOption(options, partial.name), partial: partial.value, nameMatches: [] }
	}
	const exact = findOption(options, partial.name)
	const nameMatches = options.filter((option) => option.name.startsWith(partial.name))
	return { option: exact, partial: partial.name, nameMatches }
}

/** Choices of `option` starting with `prefix`; all of them for an empty prefix. */
export function matchingChoices(option: ScriptOption, prefix: string): string[] {
	const choices = option.choices ?? []
	return choices.filter((choice) => choice.startsWith(prefix))
}

function quoteTypedValue(value: string): string {
	return /[\s"'\\]/.test(value) ? `"${value.replace(/["\\]/g, "\\$&")}"` : value
}

/**
 * Tab in the composer: completes the option or choice being typed, then jumps
 * to the next missing required option. Returns the new option text.
 */
export function completeTypedOptions(text: string, options: readonly ScriptOption[]): string {
	const parsed = parseTypedOptions(text, options)
	let next = text
	const partial = parsed.partial
	if (partial) {
		const head = text.slice(0, partial.start)
		const option = findOption(options, partial.name)
		if (partial.hasColon) {
			if (option?.kind === "choice") {
				const [match] = matchingChoices(option, partial.value)
				if (match === undefined) return text
				next = `${head}${option.name}:${match} `
			} else if (option?.kind === "text" && partial.value !== "" && !partial.unclosed) {
				next = `${text} `
			} else {
				return text
			}
		} else {
			const unset = options.filter((candidate) => !(candidate.name in parsed.values))
			const match = unset.find((candidate) => candidate.name.startsWith(partial.name))
			if (!match) return text
			next = `${head}${match.name}${match.kind === "flag" ? " " : ":"}`
		}
	}
	if (next === "" || /\s$/.test(next)) {
		const after = parseTypedOptions(next, options)
		const missing = after.missing[0]
		if (missing) next += `${missing.name}:`
	}
	return next
}

/**
 * Puts `name` (a flag, when `value` is true) or `name:value` into the typed text, replacing an
 * earlier token for that option or the bare word being typed. An empty value leaves `name:` open
 * for the user to finish; anything else ends with a space, ready for the next option.
 */
export function setTypedOption(
	text: string,
	options: readonly ScriptOption[],
	name: string,
	value: string | true = true,
): string {
	const parsed = parseTypedOptions(text, options)
	const partial = parsed.partial
	const replacesPartial =
		!!partial && !partial.hasColon && partial.name !== "" && partial.name !== name && name.startsWith(partial.name)
	const kept = parsed.tokens.filter((token) => token.name !== name && !(replacesPartial && token === partial))
	const head = kept.map((token) => token.raw).join(" ")
	const added = value === true ? `${name} ` : value === "" ? `${name}:` : `${name}:${quoteTypedValue(value)} `
	return `${head}${head ? " " : ""}${added}`
}

/** Typed text for a set of values, in declaration order (used to echo what will run). */
export function formatTypedOptions(options: readonly ScriptOption[], values: ScriptValues): string {
	const parts: string[] = []
	for (const option of options) {
		const value = values[option.name]
		if (value === undefined || value === false || value === "") continue
		parts.push(option.kind === "flag" ? option.name : `${option.name}:${quoteTypedValue(String(value))}`)
	}
	return parts.join(" ")
}

// ---------------------------------------------------------------------------
// Invocation text: `/script-name module:api watch`
// ---------------------------------------------------------------------------

/**
 * A message starting with `/<script>` runs that script. The rest of the first
 * line is the typed options; later lines are a note for the agent.
 */
export function splitScriptInvocation(text: string): { name: string; optionsText: string; note: string } | null {
	const match = /^\s*\/([a-z0-9][a-z0-9_-]*)(?=\s|$)([^\n]*)(?:\n([\s\S]*))?$/.exec(text)
	if (!match) return null
	return { name: match[1], optionsText: match[2].trim(), note: (match[3] ?? "").trim() }
}

// ---------------------------------------------------------------------------
// Wire types (webview <-> extension are proto-backed; these mirror them)
// ---------------------------------------------------------------------------

export const SCRIPT_APPROVAL_LABELS: Record<ScriptApproval, string> = {
	always_ask: "Always ask",
	ask_in_ask_mode: "Ask mode asks",
	always_allow: "Always allow",
}
