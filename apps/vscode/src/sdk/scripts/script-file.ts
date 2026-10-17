import { parseYamlFrontmatter } from "@core/context/instructions/user-instructions/frontmatter"
import {
	DEFAULT_SCRIPT_APPROVAL,
	SCRIPT_APPROVALS,
	SCRIPT_NAME_REGEX,
	SCRIPT_OPTION_KINDS,
	SCRIPT_OPTION_NAME_REGEX,
	type ScriptApproval,
	type ScriptOption,
	type ScriptOptionKind,
} from "@shared/scripts"
import * as yaml from "js-yaml"
import { validateCommandTemplate } from "./script-command"

export type ScriptScope = "global" | "workspace"

export interface ScriptDefinition {
	name: string
	/** When to use it: the one line the agent sees in the index. */
	description: string
	/** The exact command template. */
	command: string
	cwd?: string
	approval: ScriptApproval
	options: ScriptOption[]
	/** Usage notes for the agent: the Markdown body. */
	notes: string
	filePath: string
	scope: ScriptScope
}

export interface ParsedScriptFile {
	/** Absent when the file is invalid. */
	script?: ScriptDefinition
	/** Best-effort name even for invalid files, so the list can show them. */
	name: string
	description: string
	errors: string[]
}

const MAX_OPTIONS = 20

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined
}

function parseOption(raw: unknown, index: number, errors: string[]): ScriptOption | undefined {
	const label = `options[${index}]`
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		errors.push(`${label} must be a mapping with name and kind`)
		return undefined
	}
	const entry = raw as Record<string, unknown>
	const name = asString(entry.name)
	if (!name || !SCRIPT_OPTION_NAME_REGEX.test(name)) {
		errors.push(`${label}.name must be lowercase letters, digits, "-" or "_", starting with a letter`)
		return undefined
	}
	const kind = entry.kind
	if (typeof kind !== "string" || !SCRIPT_OPTION_KINDS.includes(kind as ScriptOptionKind)) {
		errors.push(`Option "${name}": kind must be one of ${SCRIPT_OPTION_KINDS.join(", ")}`)
		return undefined
	}
	const option: ScriptOption = {
		name,
		kind: kind as ScriptOptionKind,
		required: entry.required === true,
		description: asString(entry.description)?.trim() ?? "",
	}
	if (entry.required !== undefined && typeof entry.required !== "boolean") {
		errors.push(`Option "${name}": required must be true or false`)
	}
	if (option.kind === "choice") {
		const choices = entry.choices
		if (entry.choicesFrom !== undefined) {
			if (entry.choicesFrom !== "mmrc") errors.push(`Option "${name}": choicesFrom must be "mmrc"`)
			else option.choicesFrom = "mmrc"
		}
		if (choices !== undefined) {
			if (!Array.isArray(choices) || choices.some((choice) => typeof choice !== "string" || choice === "")) {
				errors.push(`Option "${name}": choices must be a list of non-empty strings`)
			} else {
				option.choices = choices as string[]
			}
		}
		if (!option.choices?.length && !option.choicesFrom) {
			errors.push(`Option "${name}": a choice option needs choices or choicesFrom: mmrc`)
		}
	} else if (entry.choices !== undefined || entry.choicesFrom !== undefined) {
		errors.push(`Option "${name}": only choice options take choices`)
	}
	if (entry.default !== undefined) {
		if (option.kind === "flag") {
			if (typeof entry.default === "boolean") option.default = entry.default
			else errors.push(`Option "${name}": a flag default must be true or false`)
		} else if (typeof entry.default === "string" || typeof entry.default === "number") {
			option.default = String(entry.default)
			if (option.kind === "choice" && option.choices && !option.choices.includes(option.default)) {
				errors.push(`Option "${name}": default must be one of its choices`)
			}
		} else {
			errors.push(`Option "${name}": default must be a string`)
		}
	}
	return option
}

/**
 * Parses and validates a script file. Invalid files return errors and no
 * `script`, so the agent never sees (or runs) something half-defined.
 */
export function parseScriptFile(
	content: string,
	file: { filePath: string; scope: ScriptScope; fallbackName: string },
): ParsedScriptFile {
	const { data, body, hadFrontmatter, parseError } = parseYamlFrontmatter(content)
	const errors: string[] = []
	const fallback = file.fallbackName
	if (!hadFrontmatter) {
		return { name: fallback, description: "", errors: ["Missing YAML frontmatter (---) with name, description and command"] }
	}
	if (parseError) return { name: fallback, description: "", errors: [`Frontmatter is not valid YAML: ${parseError}`] }

	const name = (asString(data.name) ?? fallback).trim()
	const description = asString(data.description)?.trim() ?? ""
	const command = asString(data.command)?.trim() ?? ""
	if (!SCRIPT_NAME_REGEX.test(name)) errors.push('name must be lowercase letters, digits, "-" or "_" (it is typed as /name)')
	if (!description) errors.push("description is required: say when the agent should use this script")
	if (!command) errors.push("command is required")
	const cwd = data.cwd === undefined ? undefined : asString(data.cwd)?.trim()
	if (data.cwd !== undefined && !cwd) errors.push("cwd must be a path")

	let approval = DEFAULT_SCRIPT_APPROVAL
	if (data.approval !== undefined) {
		if (typeof data.approval === "string" && SCRIPT_APPROVALS.includes(data.approval as ScriptApproval)) {
			approval = data.approval as ScriptApproval
		} else {
			errors.push(`approval must be one of ${SCRIPT_APPROVALS.join(", ")}`)
		}
	}

	const options: ScriptOption[] = []
	if (data.options !== undefined) {
		if (!Array.isArray(data.options)) {
			errors.push("options must be a list")
		} else if (data.options.length > MAX_OPTIONS) {
			errors.push(`At most ${MAX_OPTIONS} options are supported`)
		} else {
			data.options.forEach((raw, index) => {
				const option = parseOption(raw, index, errors)
				if (!option) return
				if (options.some((existing) => existing.name === option.name))
					errors.push(`Option "${option.name}" is declared twice`)
				else options.push(option)
			})
		}
	}
	if (command) errors.push(...validateCommandTemplate(command, options))

	if (errors.length > 0) return { name, description, errors }
	return {
		name,
		description,
		errors,
		script: {
			name,
			description,
			command,
			...(cwd ? { cwd } : {}),
			approval,
			options,
			notes: body.trim(),
			filePath: file.filePath,
			scope: file.scope,
		},
	}
}

/** Sets or replaces `approval` in the frontmatter, leaving the rest of the file as written. */
export function setScriptApprovalInContent(content: string, approval: ScriptApproval): string {
	const match = /^(﻿?---\r?\n)([\s\S]*?)(\r?\n---)/.exec(content)
	if (!match) return content
	const [whole, open, frontmatter, close] = match
	const line = `approval: ${approval}`
	const next = /^approval\s*:.*$/m.test(frontmatter)
		? frontmatter.replace(/^approval\s*:.*$/m, line)
		: `${frontmatter}\n${line}`
	return `${open}${next}${close}${content.slice(whole.length)}`
}

/** Starter file for "New script". */
export function scriptTemplate(name: string): string {
	const frontmatter = yaml
		.dump(
			{
				name,
				description: "When the agent should use this script (one line)",
				command: "echo Hello {{who}}{{#shout}} !!!{{/shout}}",
				approval: DEFAULT_SCRIPT_APPROVAL,
				options: [
					{ name: "who", kind: "text", required: true, description: "Who to greet" },
					{ name: "shout", kind: "flag", required: false, description: "Add emphasis" },
				],
			},
			{ lineWidth: 100 },
		)
		.trimEnd()
	return `---
${frontmatter}
---

# ${name}

Usage notes for the agent: what the script does, what its options mean, and what to check afterwards.

- \`{{option}}\` in the command is replaced by that option's value, quoted for the shell.
- \`{{#flag}}…{{/flag}}\` is included only when the option is set; \`{{^flag}}…{{/flag}}\` only when it is not.
- \`approval\` is one of \`always_ask\`, \`ask_in_ask_mode\` (default) or \`always_allow\`.
- A choice option can list its \`choices\`, or use \`choicesFrom: mmrc\` to list the modules in \`.mmrc\`.
`
}
