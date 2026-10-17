import { MAX_SCRIPT_TEXT_VALUE_LENGTH, SCRIPT_OPTION_NAME_REGEX, type ScriptOption, type ScriptValues } from "@shared/scripts"

/**
 * Command templates: the saved `command` with `{{option}}` placeholders and
 * `{{#option}}…{{/option}}` / `{{^option}}…{{/option}}` sections (included when
 * the option is / is not set). Values only ever enter a command through a
 * placeholder, shell-quoted, so the agent and the composer cannot add anything
 * the script's author did not write.
 */

export type TemplatePart =
	| { type: "text"; text: string }
	| { type: "value"; name: string }
	| { type: "section"; name: string; negate: boolean; parts: TemplatePart[] }

const TAG_REGEX = /\{\{\s*([#^/]?)\s*([A-Za-z0-9_-]+)\s*\}\}/g

export function parseCommandTemplate(template: string): { parts: TemplatePart[]; errors: string[] } {
	const errors: string[] = []
	const root: TemplatePart[] = []
	let current = root
	let open: { name: string; negate: boolean; parts: TemplatePart[] } | undefined
	let cursor = 0
	for (const match of template.matchAll(TAG_REGEX)) {
		const index = match.index ?? 0
		if (index > cursor) current.push({ type: "text", text: template.slice(cursor, index) })
		cursor = index + match[0].length
		const [, sigil, name] = match
		if (!SCRIPT_OPTION_NAME_REGEX.test(name)) {
			errors.push(`"${name}" is not a valid option name in the command`)
			continue
		}
		if (sigil === "#" || sigil === "^") {
			if (open) {
				errors.push(`Sections cannot be nested ({{${sigil}${name}}} inside {{#${open.name}}})`)
				continue
			}
			open = { name, negate: sigil === "^", parts: [] }
			current = open.parts
		} else if (sigil === "/") {
			if (!open || open.name !== name) {
				errors.push(`{{/${name}}} closes a section that is not open`)
				continue
			}
			root.push({ type: "section", name, negate: open.negate, parts: open.parts })
			open = undefined
			current = root
		} else {
			current.push({ type: "value", name })
		}
	}
	if (cursor < template.length) current.push({ type: "text", text: template.slice(cursor) })
	if (open) errors.push(`{{#${open.name}}} is never closed`)
	// A stray "{{" that did not form a tag usually means a typo.
	const stray = template.replace(TAG_REGEX, "").includes("{{")
	if (stray) errors.push('The command contains "{{" that is not a valid placeholder')
	return { parts: root, errors }
}

function referencedNames(parts: TemplatePart[]): { name: string; value: boolean }[] {
	return parts.flatMap((part) => {
		if (part.type === "text") return []
		if (part.type === "value") return [{ name: part.name, value: true }]
		return [{ name: part.name, value: false }, ...referencedNames(part.parts)]
	})
}

/** Static checks of a template against the declared options. */
export function validateCommandTemplate(template: string, options: readonly ScriptOption[]): string[] {
	const { parts, errors } = parseCommandTemplate(template)
	for (const reference of referencedNames(parts)) {
		const option = options.find((candidate) => candidate.name === reference.name)
		if (!option) errors.push(`The command uses {{${reference.name}}}, which is not a declared option`)
		else if (reference.value && option.kind === "flag") {
			errors.push(`Flag "${option.name}" cannot be used as a value; use {{#${option.name}}}…{{/${option.name}}}`)
		}
	}
	return [...new Set(errors)]
}

const SAFE_POSIX_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/
// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/
// Characters cmd.exe and PowerShell treat specially even inside double quotes.
const UNSAFE_WINDOWS_CHARACTERS = /["%^&|<>`$!]/

export function quoteShellValue(value: string, platform: NodeJS.Platform = process.platform): string {
	if (platform === "win32") {
		if (UNSAFE_WINDOWS_CHARACTERS.test(value)) {
			throw new Error("This value contains characters that cannot be passed safely on Windows")
		}
		return value === "" || /[\s;()]/.test(value) ? `"${value}"` : value
	}
	if (value !== "" && SAFE_POSIX_WORD.test(value)) return value
	return `'${value.replace(/'/g, "'\\''")}'`
}

function isSet(option: ScriptOption, values: ScriptValues): boolean {
	const value = values[option.name]
	return option.kind === "flag" ? value === true : typeof value === "string" && value !== ""
}

export type ResolvedScriptRun = { ok: true; values: ScriptValues; command: string } | { ok: false; error: string }

/**
 * Validates raw option values (from the agent or the composer) against the
 * declarations and renders the command. Anything not declared is rejected.
 */
export function resolveScriptRun(
	script: { command: string; options: readonly ScriptOption[] },
	input: Record<string, unknown> | undefined,
	platform: NodeJS.Platform = process.platform,
): ResolvedScriptRun {
	const raw = input ?? {}
	if (typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "options must be an object of option values." }
	for (const name of Object.keys(raw)) {
		if (!script.options.some((option) => option.name === name)) {
			const declared = script.options.map((option) => option.name).join(", ") || "none"
			return { ok: false, error: `Unknown option "${name}". Declared options: ${declared}.` }
		}
	}
	const values: ScriptValues = {}
	for (const option of script.options) {
		const given = raw[option.name]
		if (given === undefined || given === null || given === "") {
			if (option.default !== undefined) values[option.name] = option.default
			else if (option.required) return { ok: false, error: `Option "${option.name}" is required.` }
			continue
		}
		if (option.kind === "flag") {
			const flag = given === true || given === "true" ? true : given === false || given === "false" ? false : undefined
			if (flag === undefined) return { ok: false, error: `Option "${option.name}" is a flag; pass true or false.` }
			if (flag || option.default === true) values[option.name] = flag
			continue
		}
		if (typeof given !== "string" && typeof given !== "number") {
			return { ok: false, error: `Option "${option.name}" must be a string.` }
		}
		const value = String(given)
		if (value.length > MAX_SCRIPT_TEXT_VALUE_LENGTH) return { ok: false, error: `Option "${option.name}" is too long.` }
		if (CONTROL_CHARACTERS.test(value)) {
			return { ok: false, error: `Option "${option.name}" contains control characters (such as a newline).` }
		}
		if (option.kind === "choice" && !(option.choices ?? []).includes(value)) {
			return {
				ok: false,
				error: `Option "${option.name}" must be one of: ${(option.choices ?? []).join(", ") || "(no choices available)"}.`,
			}
		}
		values[option.name] = value
	}
	const { parts, errors } = parseCommandTemplate(script.command)
	if (errors.length > 0) return { ok: false, error: errors[0] }
	try {
		const render = (list: TemplatePart[]): string =>
			list
				.map((part) => {
					if (part.type === "text") return part.text
					if (part.type === "value") {
						const option = script.options.find((candidate) => candidate.name === part.name)
						if (!option) throw new Error(`Option "${part.name}" is not declared.`)
						return isSet(option, values) ? quoteShellValue(String(values[part.name]), platform) : ""
					}
					const option = script.options.find((candidate) => candidate.name === part.name)
					if (!option) throw new Error(`Option "${part.name}" is not declared.`)
					return isSet(option, values) !== part.negate ? render(part.parts) : ""
				})
				.join("")
		// No whitespace collapsing: it would alter quoted values. Sections carry their own leading space.
		const command = render(parts).trim()
		return { ok: true, values, command }
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) }
	}
}
