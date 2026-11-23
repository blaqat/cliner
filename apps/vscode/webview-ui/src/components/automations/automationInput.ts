import type { AutomationArgument } from "@shared/automations"
import type { AutomationEntry } from "@/hooks/useAutomations"

export type RunnableAutomation = AutomationEntry & { definition: NonNullable<AutomationEntry["definition"]> }

/**
 * A composer draft that starts an automation: `/name`, its arguments, then any context for the run. The
 * composer shows the arguments as chips with a field each, and the context in the text box under them.
 * The draft text stays the source of truth (so drafts, stashes and history keep working):
 * `/name ticket:PROJ-7 depth:quick` on the first line, the context on the lines after it.
 */
export interface AutomationDraft {
	automation: RunnableAutomation
	/** Typed values by argument name; an argument with no value is absent. */
	values: Record<string, string>
	/** Free text for the run: everything past the last argument. */
	context: string
}

interface Token {
	/** `name` of a `name:value` token for a declared argument; absent for a positional value. */
	key?: string
	value: string
	start: number
}

/** Splits the argument line into `name:value`, `name:"quoted"`, `"quoted"` and bare tokens. */
function tokenize(line: string, names: ReadonlySet<string>): Token[] {
	const tokens: Token[] = []
	let index = 0
	const readQuoted = (quote: string) => {
		let value = ""
		index++
		while (index < line.length && line[index] !== quote) {
			if (line[index] === "\\" && (line[index + 1] === quote || line[index + 1] === "\\")) index++
			value += line[index++]
		}
		index++
		return value
	}
	while (index < line.length) {
		if (/\s/.test(line[index])) {
			index++
			continue
		}
		const start = index
		const keyed = /^([a-z][a-z0-9_-]*):/.exec(line.slice(index))
		if (keyed && names.has(keyed[1])) {
			index += keyed[0].length
			const quote = line[index]
			if (quote === '"' || quote === "'") tokens.push({ key: keyed[1], value: readQuoted(quote), start })
			else {
				const end = line.slice(index).search(/\s|$/)
				tokens.push({ key: keyed[1], value: line.slice(index, index + end), start })
				index += end
			}
			continue
		}
		if (line[index] === '"' || line[index] === "'") {
			tokens.push({ value: readQuoted(line[index]), start })
			continue
		}
		const end = line.slice(index).search(/\s|$/)
		tokens.push({ value: line.slice(index, index + end), start })
		index += end
	}
	return tokens
}

/**
 * Reads a draft that starts with `/name ` (a space after the name, so a name still being typed in the
 * slash menu isn't one). Values typed as `name:value` go to that argument; bare values fill the
 * arguments in order, one word or quoted phrase each. What's left of the line, and the lines after it,
 * is context: so `/fix-ticket PROJ-7 quick` typed fast fills both arguments.
 */
export function parseAutomationDraft(text: string, automations: readonly RunnableAutomation[]): AutomationDraft | null {
	const match = /^\s*\/([a-z0-9][a-z0-9_-]*)[ \t]+([^\n]*)(?:\n([\s\S]*))?$/.exec(text)
	if (!match) return null
	const automation = automations.find((candidate) => candidate.name === match[1])
	if (!automation) return null
	const args = automation.definition.arguments
	const line = match[2]
	const values: Record<string, string> = {}
	let rest = ""
	for (const token of tokenize(line, new Set(args.map((arg) => arg.name)))) {
		if (token.key && values[token.key] === undefined) {
			if (token.value) values[token.key] = token.value
			continue
		}
		const next = args.find((arg) => values[arg.name] === undefined && !(token.key && arg.name === token.key))
		if (!next || token.key) {
			rest = line.slice(token.start).trim()
			break
		}
		if (token.value) values[next.name] = token.value
		else values[next.name] = ""
	}
	for (const [name, value] of Object.entries(values)) if (!value) delete values[name]
	const later = match[3]
	const context = rest && later !== undefined ? `${rest}\n${later}` : rest || (later ?? "")
	return { automation, values, context }
}

function quote(value: string): string {
	return /[\s"'\\]/.test(value) || value === "" ? `"${value.replace(/["\\]/g, "\\$&")}"` : value
}

/** The draft text for these values and context: parsing it gives them back. */
export function serializeAutomationDraft(
	name: string,
	args: readonly AutomationArgument[],
	values: Readonly<Record<string, string>>,
	context: string,
): string {
	const parts = args.flatMap((arg) => {
		const value = values[arg.name]
		return value ? [`${arg.name}:${quote(value.replace(/\r?\n/g, " "))}`] : []
	})
	return `/${name} ${parts.join(" ")}${context ? `\n${context}` : ""}`
}

/** An argument's problem with its value as typed: a choice that isn't one. */
export function argumentProblem(arg: AutomationArgument, value: string | undefined): string | undefined {
	if (arg.kind === "choice" && value && !(arg.choices ?? []).includes(value))
		return `${arg.name} must be one of ${(arg.choices ?? []).join(", ")}`
	return undefined
}

/** Required arguments with no value and no default, in order. */
export function missingArguments(draft: AutomationDraft): AutomationArgument[] {
	return draft.automation.definition.arguments.filter((arg) => arg.required && !draft.values[arg.name] && !arg.default)
}

/** Argument values the draft gives, or the one reason it can't run yet. */
export function automationDraftValues(draft: AutomationDraft): { values: Record<string, string> } | { reason: string } {
	for (const arg of draft.automation.definition.arguments) {
		const problem = argumentProblem(arg, draft.values[arg.name])
		if (problem) return { reason: problem }
	}
	const missing = missingArguments(draft)
	if (missing.length) return { reason: `Needs ${missing.map((arg) => arg.name).join(", ")}` }
	return { values: { ...draft.values } }
}

/** Choices of a choice argument starting with what's typed (all of them when nothing is). */
export function matchingChoices(arg: AutomationArgument, typed: string): string[] {
	const choices = arg.choices ?? []
	const lower = typed.toLowerCase()
	return choices.filter((choice) => choice.toLowerCase().startsWith(lower))
}
