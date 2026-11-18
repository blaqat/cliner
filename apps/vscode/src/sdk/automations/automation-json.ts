import {
	AUTOMATION_ARG_KINDS,
	type AutomationArgKind,
	type AutomationArgument,
	type AutomationDefinition,
	type AutomationStep,
	type AutomationThreadSpec,
} from "@shared/automations"

type Raw = Record<string, unknown>

const str = (value: unknown): string => (typeof value === "string" ? value : "")
const record = (value: unknown): Raw =>
	typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Raw) : {}
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

function thread(raw: unknown): AutomationThreadSpec {
	const entry = record(raw)
	return {
		id: str(entry.id),
		title: str(entry.title),
		prompt: str(entry.prompt),
		model: str(entry.model),
		level: str(entry.level),
		mode: entry.mode === "act" ? "act" : "ask",
		worktree: entry.worktree === true,
	}
}

function step(raw: unknown): AutomationStep | undefined {
	const entry = record(raw)
	const base = { id: str(entry.id), title: str(entry.title) }
	switch (entry.kind) {
		case "task":
			return { kind: "task", ...base, ticket: str(entry.ticket), newTaskTitle: str(entry.newTaskTitle) }
		case "thread":
			return { kind: "thread", ...thread(entry), ...base }
		case "together":
			return { kind: "together", ...base, prompt: str(entry.prompt), threads: list(entry.threads).map(thread) }
		case "checkpoint":
			return {
				kind: "checkpoint",
				...base,
				question: str(entry.question),
				choicesFrom: str(entry.choicesFrom),
				choices: list(entry.choices).map(str).filter(Boolean),
			}
		default:
			return undefined
	}
}

function argument(raw: unknown): AutomationArgument {
	const entry = record(raw)
	const kind = AUTOMATION_ARG_KINDS.includes(entry.kind as AutomationArgKind) ? (entry.kind as AutomationArgKind) : "text"
	return {
		name: str(entry.name),
		kind,
		required: entry.required === true,
		description: str(entry.description),
		...(kind === "choice" ? { choices: list(entry.choices).map(str).filter(Boolean) } : {}),
		...(str(entry.default) ? { default: str(entry.default) } : {}),
	}
}

/**
 * A definition from the webview, keeping only the fields and types the file format knows. Validation
 * (names, placeholders, step order) happens when it is saved.
 */
export function parseDefinitionJson(json: string): AutomationDefinition {
	let parsed: unknown
	try {
		parsed = JSON.parse(json)
	} catch {
		throw new Error("The automation couldn't be read.")
	}
	const entry = record(parsed)
	return {
		name: str(entry.name).trim(),
		title: str(entry.title),
		description: str(entry.description),
		arguments: list(entry.arguments).map(argument),
		steps: list(entry.steps)
			.map(step)
			.filter((item): item is AutomationStep => !!item),
	}
}
