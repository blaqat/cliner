import { parseYamlFrontmatter } from "@core/context/instructions/user-instructions/frontmatter"
import {
	AUTOMATION_ARG_KINDS,
	type AutomationArgKind,
	type AutomationArgument,
	type AutomationDefinition,
	type AutomationIssue,
	type AutomationMode,
	type AutomationStep,
	type AutomationThreadSpec,
	validateAutomation,
} from "@shared/automations"
import * as yaml from "js-yaml"

/**
 * The readable file an automation is saved as. The builder writes it; people read it (and can diff and
 * share it), but never have to edit it. Markdown with YAML frontmatter for the name and arguments, then one
 * `##` heading per step: a few `- key: value` lines, a blank line, and the prompt. A `together` step's
 * threads are `###` headings under it.
 *
 * ```md
 * ## Research
 * - id: research
 * - kind: thread
 * - model: Sonnet 5.5
 * - level: medium
 * - mode: ask
 *
 * Read {{ticket}} and the code it touches.
 * ```
 */

export type AutomationScope = "global" | "workspace"

export interface ParsedAutomationFile {
	/** Absent when the file is invalid. */
	definition?: AutomationDefinition
	/** What could be read even with problems: a model's draft opens in the builder this way. */
	draft?: AutomationDefinition
	/** Best effort even for invalid files, so the list can show them. */
	name: string
	description: string
	errors: string[]
}

const STEP_KINDS = ["task", "thread", "together", "checkpoint"] as const
const FENCE = "````"
const HEADER_COMMENT = "<!-- Made with the automation builder (Rules & workflows › Automations). Edit it there. -->"

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : typeof value === "number" ? String(value) : undefined
}

function parseArgument(raw: unknown, index: number, errors: string[]): AutomationArgument | undefined {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		errors.push(`arguments[${index}] must be a mapping with name and kind`)
		return undefined
	}
	const entry = raw as Record<string, unknown>
	const name = asString(entry.name)?.trim() ?? ""
	const kind = asString(entry.kind) ?? "text"
	if (!AUTOMATION_ARG_KINDS.includes(kind as AutomationArgKind)) {
		errors.push(`Argument "${name}": kind must be one of ${AUTOMATION_ARG_KINDS.join(", ")}`)
		return undefined
	}
	const choices = entry.choices
	if (choices !== undefined && (!Array.isArray(choices) || choices.some((choice) => asString(choice) === undefined))) {
		errors.push(`Argument "${name}": choices must be a list of words`)
	}
	return {
		name,
		kind: kind as AutomationArgKind,
		required: entry.required === true,
		description: asString(entry.description)?.trim() ?? "",
		...(kind === "choice" && Array.isArray(choices) ? { choices: choices.map((choice) => String(choice)) } : {}),
		...(entry.default !== undefined && asString(entry.default) !== undefined ? { default: asString(entry.default) } : {}),
	}
}

interface Section {
	level: 2 | 3
	heading: string
	meta: Record<string, string>
	body: string
}

/** Splits the Markdown body into `##` and `###` sections; text before the first `##` is a preamble. */
function splitSections(body: string): Section[] {
	const sections: Section[] = []
	const lines = body.replace(/\r\n/g, "\n").split("\n")
	let current: { level: 2 | 3; heading: string; lines: string[] } | undefined
	let inFence = false
	const flush = () => {
		if (!current) return
		const meta: Record<string, string> = {}
		let index = 0
		while (index < current.lines.length && current.lines[index].trim() === "") index++
		for (; index < current.lines.length; index++) {
			const match = /^- ([a-z][a-z ]*):[ \t]*(.*)$/.exec(current.lines[index])
			if (!match) break
			meta[match[1].trim()] = match[2].trim()
		}
		let text = current.lines.slice(index).join("\n").trim()
		if (text.startsWith(FENCE) && text.endsWith(FENCE)) {
			text = text.slice(text.indexOf("\n") + 1, text.length - FENCE.length).replace(/\n$/, "")
		}
		sections.push({ level: current.level, heading: current.heading, meta, body: text })
	}
	for (const line of lines) {
		if (line.startsWith(FENCE)) inFence = !inFence
		const heading = inFence ? null : /^(#{2,3}) (.*)$/.exec(line)
		if (heading) {
			flush()
			current = { level: heading[1].length as 2 | 3, heading: heading[2].trim(), lines: [] }
		} else if (current) current.lines.push(line)
	}
	flush()
	return sections
}

function readMode(value: string | undefined, at: string, errors: string[]): AutomationMode {
	if (value === undefined || value === "") return "ask"
	if (value === "ask" || value === "act") return value
	errors.push(`${at}: mode must be ask or act`)
	return "ask"
}

function readWorktree(value: string | undefined): boolean {
	return value === "new" || value === "yes" || value === "true"
}

function threadSpec(section: Section, fallbackId: string, errors: string[]): AutomationThreadSpec {
	const id = section.meta.id || fallbackId
	return {
		id,
		title: section.heading,
		prompt: section.body,
		model: section.meta.model && section.meta.model !== "default" ? section.meta.model : "",
		level: section.meta.level ?? "",
		mode: readMode(section.meta.mode, `Step "${id}"`, errors),
		worktree: readWorktree(section.meta.worktree),
	}
}

function parseSteps(body: string, errors: string[]): AutomationStep[] {
	const steps: AutomationStep[] = []
	for (const section of splitSections(body)) {
		if (section.level === 3) {
			const parent = steps[steps.length - 1]
			if (parent?.kind !== "together") {
				errors.push(`"### ${section.heading}" must sit under a together step`)
				continue
			}
			parent.threads.push(threadSpec(section, `${parent.id}-${parent.threads.length + 1}`, errors))
			continue
		}
		const kind = section.meta.kind ?? "thread"
		const id = section.meta.id || `step-${steps.length + 1}`
		if (!(STEP_KINDS as readonly string[]).includes(kind)) {
			errors.push(`Step "${section.heading}": kind must be one of ${STEP_KINDS.join(", ")}`)
			continue
		}
		switch (kind as (typeof STEP_KINDS)[number]) {
			case "task":
				steps.push({
					kind: "task",
					id,
					title: section.heading,
					ticket: section.meta.ticket ?? "",
					newTaskTitle: section.meta["new task title"] ?? "",
				})
				break
			case "thread":
				steps.push({ kind: "thread", ...threadSpec(section, id, errors), id })
				break
			case "together":
				steps.push({ kind: "together", id, title: section.heading, prompt: section.body, threads: [] })
				break
			case "checkpoint": {
				const from = section.meta["choices from"] ?? ""
				const choices = section.meta.choices
					? section.meta.choices
							.split(",")
							.map((choice) => choice.trim())
							.filter(Boolean)
					: []
				steps.push({ kind: "checkpoint", id, title: section.heading, question: section.body, choicesFrom: from, choices })
				break
			}
		}
	}
	return steps
}

/** Parses and validates an automation file. Invalid files return errors and no definition. */
export function parseAutomationFile(content: string, fallbackName: string): ParsedAutomationFile {
	const { data, body, hadFrontmatter, parseError } = parseYamlFrontmatter(content)
	if (!hadFrontmatter) return { name: fallbackName, description: "", errors: ["Missing YAML frontmatter (---) with name"] }
	if (parseError) return { name: fallbackName, description: "", errors: [`Frontmatter is not valid YAML: ${parseError}`] }
	const errors: string[] = []
	const name = (asString(data.name) ?? fallbackName).trim()
	const description = asString(data.description)?.trim() ?? ""
	const args: AutomationArgument[] = []
	if (data.arguments !== undefined) {
		if (!Array.isArray(data.arguments)) errors.push("arguments must be a list")
		else
			data.arguments.forEach((raw, index) => {
				const arg = parseArgument(raw, index, errors)
				if (arg) args.push(arg)
			})
	}
	const definition: AutomationDefinition = {
		name,
		title: asString(data.title)?.trim() ?? "",
		description,
		arguments: args,
		steps: parseSteps(body, errors),
	}
	if (data["cost limit"] !== undefined) {
		const limit = Number(String(data["cost limit"]).replace(/^\$/, ""))
		if (Number.isFinite(limit) && limit > 0) definition.costLimit = limit
		else errors.push('"cost limit" must be a dollar amount, like 5 or 2.50')
	}
	errors.push(...formatIssues(validateAutomation(definition)))
	return errors.length > 0
		? { name, description, errors, draft: definition }
		: { name, description, errors, definition, draft: definition }
}

export function formatIssues(issues: readonly AutomationIssue[]): string[] {
	return issues.map((issue) =>
		issue.at && !issue.at.startsWith("arg:") ? `Step "${issue.at}": ${issue.message}` : issue.message,
	)
}

/** A heading must stay on one line and can't open a fence. */
function headingText(text: string, fallback: string): string {
	return text.replace(/\s+/g, " ").trim() || fallback
}

/** A meta value stays on one line. */
function metaValue(text: string): string {
	return text.replace(/\s+/g, " ").trim()
}

/** Prompts that contain heading-like lines or fences are fenced, so they read back exactly. */
function promptBlock(prompt: string): string {
	const text = prompt.replace(/\r\n/g, "\n").trim()
	if (!text) return ""
	return /^(#|- [a-z][a-z ]*:|`{3,})/m.test(text) ? `${FENCE}text\n${text}\n${FENCE}` : text
}

function section(level: 2 | 3, heading: string, meta: [string, string][], prompt = ""): string {
	const lines = [
		`${"#".repeat(level)} ${heading}`,
		...meta.filter(([, value]) => value !== "").map(([k, v]) => `- ${k}: ${metaValue(v)}`),
	]
	const block = promptBlock(prompt)
	return block ? `${lines.join("\n")}\n\n${block}` : lines.join("\n")
}

function threadMeta(thread: AutomationThreadSpec, withKind: boolean): [string, string][] {
	return [
		["id", thread.id],
		...(withKind ? ([["kind", "thread"]] as [string, string][]) : []),
		["model", thread.model || "default"],
		["level", thread.level],
		["mode", thread.mode],
		["worktree", thread.worktree ? "new" : ""],
	]
}

/** The readable file for a definition. Parsing it gives the same definition back. */
export function serializeAutomation(definition: AutomationDefinition): string {
	const frontmatter = yaml
		.dump(
			{
				name: definition.name,
				...(definition.title.trim() ? { title: definition.title.trim() } : {}),
				description: definition.description.trim(),
				...(definition.costLimit ? { "cost limit": definition.costLimit } : {}),
				...(definition.arguments.length
					? {
							arguments: definition.arguments.map((arg) => ({
								name: arg.name,
								kind: arg.kind,
								...(arg.required ? { required: true } : {}),
								...(arg.description ? { description: arg.description } : {}),
								...(arg.kind === "choice" ? { choices: arg.choices ?? [] } : {}),
								...(arg.default ? { default: arg.default } : {}),
							})),
						}
					: {}),
			},
			{ lineWidth: 100 },
		)
		.trimEnd()
	const parts = definition.steps.map((step) => {
		const heading = headingText(step.title, step.id)
		switch (step.kind) {
			case "task":
				return section(2, heading, [
					["id", step.id],
					["kind", "task"],
					["ticket", step.ticket],
					["new task title", step.newTaskTitle],
				])
			case "thread":
				return section(2, heading, threadMeta(step, true), step.prompt)
			case "together":
				return [
					section(
						2,
						heading,
						[
							["id", step.id],
							["kind", "together"],
						],
						step.prompt,
					),
					...step.threads.map((thread) =>
						section(3, headingText(thread.title, thread.id), threadMeta(thread, false), thread.prompt),
					),
				].join("\n\n")
			case "checkpoint":
				return section(
					2,
					heading,
					[
						["id", step.id],
						["kind", "checkpoint"],
						["choices from", step.choicesFrom],
						["choices", step.choicesFrom ? "" : step.choices.join(", ")],
					],
					step.question,
				)
		}
	})
	const title = definition.title.trim() || definition.name
	return `---\n${frontmatter}\n---\n\n# ${headingText(title, definition.name)}\n\n${HEADER_COMMENT}\n\n${parts.join("\n\n")}\n`
}
