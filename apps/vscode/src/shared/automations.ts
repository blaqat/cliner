/**
 * Automations: a named recipe of steps the user starts with `/name` (never the agent). Steps open a
 * task, start prompt threads (alone or several together), pause for the user, and fan out over a list
 * (For each: one task per item, running the steps after it in each). This module is shared
 * by the extension (file format, runtime) and the webview (builder, start form, run block), so it must
 * stay free of Node and DOM imports.
 */

import { SCRIPT_NAME_REGEX, type ScriptOption } from "./scripts"
import { BASE_SLASH_COMMANDS, VSCODE_ONLY_COMMANDS } from "./slashCommands"
import type { ThreadWorkspaceChoice } from "./thread-worktrees"

export type AutomationArgKind = "text" | "ticket" | "branch" | "choice"
export const AUTOMATION_ARG_KINDS: readonly AutomationArgKind[] = ["text", "ticket", "branch", "choice"]

export interface AutomationArgument {
	name: string
	kind: AutomationArgKind
	required: boolean
	description: string
	/** Allowed values for `choice` arguments. */
	choices?: string[]
	default?: string
}

/** "ask" is the UI name of the internal "plan" mode. */
export type AutomationMode = "ask" | "act"

export interface AutomationOutput {
	name: string
	description: string
	saveAsNote?: boolean
}

/** One prompt thread: a `thread` step, or one member of a `together` step. */
export interface AutomationThreadSpec {
	id: string
	/** The thread's title in the list; placeholders allowed. */
	title: string
	/** Empty in a `together` member means "the group's prompt". */
	prompt: string
	/** A configured model's name (or upstream id). Empty runs on the default model for the mode. */
	model: string
	/** A level id of that model ("high"). Empty uses the model's default. */
	level: string
	mode: AutomationMode
	/** Legacy request for a worktree, now shared by the task. */
	worktree: boolean
	/** Omitted threads follow the task's workspace choice without creating a worktree. */
	worktreeScope?: ThreadWorkspaceChoice
	outputs?: AutomationOutput[]
}

export function automationWorkspace(thread: Pick<AutomationThreadSpec, "worktree" | "worktreeScope">) {
	return thread.worktreeScope ?? (thread.worktree ? "task" : undefined)
}

export interface AutomationTaskStep {
	kind: "task"
	id: string
	title: string
	/** Ticket key to find the task by; usually `{{ticket}}`. */
	ticket: string
	/** Title for a new task when none has the ticket; empty uses the ticket. */
	newTaskTitle: string
}

export interface AutomationThreadStep extends AutomationThreadSpec {
	kind: "thread"
}

export interface AutomationTogetherStep {
	kind: "together"
	id: string
	title: string
	/** The prompt every member without its own prompt gets. */
	prompt: string
	threads: AutomationThreadSpec[]
}

export interface AutomationCheckpointStep {
	kind: "checkpoint"
	id: string
	title: string
	/** What the user is asked. */
	question: string
	/** A `together` step whose threads are the choices; the pick's output is that thread's reply. */
	choicesFrom: string
	/** Fixed choices when `choicesFrom` is empty; none means a plain Continue. */
	choices: string[]
}

/**
 * For each: splits `items` (after placeholders) into a list and runs every step after this one once per
 * item, each in its own task, a few at a time. `{{item}}` is the item in those steps.
 */
export interface AutomationEachStep {
	kind: "each"
	id: string
	title: string
	/** The list: usually `{{tickets}}` or `{{steps.plan.list}}`. One item per line, a JSON list, or commas. */
	items: string
	/** Ticket to find each item's task by, usually `{{item}}`; empty makes a new task per item. */
	ticket: string
	/** Title for a new task; empty uses the item. */
	newTaskTitle: string
	/** Items running at the same time. */
	atOnce: number
}

export type AutomationStep =
	| AutomationTaskStep
	| AutomationThreadStep
	| AutomationTogetherStep
	| AutomationCheckpointStep
	| AutomationEachStep
export type AutomationStepKind = AutomationStep["kind"]

export interface AutomationDefinition {
	/** Typed as `/name`. */
	name: string
	/** Shown in lists; empty shows the name. */
	title: string
	description: string
	arguments: AutomationArgument[]
	steps: AutomationStep[]
	/** Dollars a run may spend before it stops itself; absent means no limit. A resume allows this much again. */
	costLimit?: number
	keepNotes?: boolean
}

export const AUTOMATION_STEP_LABELS: Record<AutomationStepKind, string> = {
	task: "Open a task",
	thread: "Prompt thread",
	together: "Threads together",
	checkpoint: "Ask you",
	each: "For each",
}

export const AUTOMATION_ID_REGEX = /^[a-z][a-z0-9-]{0,47}$/
export const AUTOMATION_ARG_NAME_REGEX = /^[a-z][a-z0-9_-]{0,47}$/
const MAX_ARGUMENTS = 20
const MAX_STEPS = 40
const MAX_TOGETHER = 8
const MAX_OUTPUTS = 20
/** Items one For each step can fan out to. */
export const MAX_EACH_ITEMS = 20
/** Items running at once, at most. */
export const MAX_EACH_AT_ONCE = 8
export const DEFAULT_EACH_AT_ONCE = 3

/** `{{context}}`: what the user added when starting the run. Usable in every step. */
export const CONTEXT_PLACEHOLDER = "context"
/** `{{item}}`: the current item, in the steps after a For each step. */
export const ITEM_PLACEHOLDER = "item"
/** Placeholder names an argument can't take. */
const RESERVED_ARG_NAMES = new Set(["steps", CONTEXT_PLACEHOLDER, ITEM_PLACEHOLDER])

export function automationDisplayName(definition: Pick<AutomationDefinition, "name" | "title">): string {
	return definition.title.trim() || definition.name
}

/** Arguments as script options, so the composer's typed-options parser, Tab completion and helper strip apply. */
export function automationArgsAsOptions(args: readonly AutomationArgument[]): ScriptOption[] {
	return args.map((arg) => ({
		name: arg.name,
		kind: arg.kind === "choice" ? "choice" : "text",
		required: arg.required,
		description: arg.description,
		...(arg.kind === "choice" ? { choices: arg.choices ?? [] } : {}),
		...(arg.default !== undefined && arg.default !== "" ? { default: arg.default } : {}),
	}))
}

/** Values with defaults applied, for every declared argument. */
export function withArgumentDefaults(
	args: readonly AutomationArgument[],
	values: Readonly<Record<string, string>>,
): Record<string, string> {
	const filled: Record<string, string> = {}
	for (const arg of args) filled[arg.name] = values[arg.name] ?? arg.default ?? ""
	return filled
}

/**
 * A short key for a ticket argument, which may be pasted text or a URL: "PROJ-7" from either, else a
 * URL's last part, else the first line cut short. Tasks are named and tagged with it.
 */
export function ticketKey(value: string): string {
	const text = value.trim()
	const key = /\b[A-Z][A-Z0-9]+-\d+\b/.exec(text)?.[0]
	if (key) return key
	const url = /https?:\/\/\S+/.exec(text)?.[0]
	if (url) {
		const parts = url
			.replace(/[?#].*$/, "")
			.split("/")
			.filter(Boolean)
		const last = parts.at(-1) ?? ""
		return /^\d+$/.test(last) && parts.length > 1 ? `${parts.at(-2)} ${last}` : last || url
	}
	const line = text.split("\n")[0].trim()
	return line.length > 40 ? `${line.slice(0, 39).trimEnd()}…` : line
}

// ---------------------------------------------------------------------------
// Placeholders: `{{ticket}}` (an argument) and `{{steps.research}}` (an earlier step's final reply)
// ---------------------------------------------------------------------------

const PLACEHOLDER_REGEX = /\{\{\s*([a-z][a-z0-9_.-]*)\s*\}\}/g

export interface PlaceholderRef {
	raw: string
	/** `arg` for `{{name}}`, `step` for `{{steps.id}}`. */
	kind: "arg" | "step"
	name: string
}

export function placeholderRefs(text: string): PlaceholderRef[] {
	const refs: PlaceholderRef[] = []
	for (const match of text.matchAll(PLACEHOLDER_REGEX)) {
		const key = match[1]
		if (key.startsWith("steps.")) refs.push({ raw: match[0], kind: "step", name: key.slice("steps.".length) })
		else refs.push({ raw: match[0], kind: "arg", name: key })
	}
	return refs
}

/** Fills placeholders; one with no value becomes empty, so a skipped step never leaves `{{…}}` in a prompt. */
export function fillPlaceholders(
	text: string,
	context: { args: Readonly<Record<string, string>>; outputs: Readonly<Record<string, string>> },
): string {
	return text.replace(PLACEHOLDER_REGEX, (_raw, key: string) =>
		key.startsWith("steps.") ? (context.outputs[key.slice("steps.".length)] ?? "") : (context.args[key] ?? ""),
	)
}

/** Every thread the steps start, in order, with the step that starts it. */
export function automationThreads(
	steps: readonly AutomationStep[],
): { step: AutomationThreadStep | AutomationTogetherStep; thread: AutomationThreadSpec }[] {
	return steps.flatMap((step): { step: AutomationThreadStep | AutomationTogetherStep; thread: AutomationThreadSpec }[] =>
		step.kind === "thread"
			? [{ step, thread: step }]
			: step.kind === "together"
				? step.threads.map((thread) => ({ step, thread }))
				: [],
	)
}

/** Counts and marks shared worktrees. Open a task and For each start a new task's steps. */
export function automationTaskWorktrees(steps: readonly AutomationStep[]) {
	const threadSteps = new Set<string>()
	let count = 0
	let span: AutomationStep[] = []
	const finish = () => {
		if (automationThreads(span).some(({ thread }) => automationWorkspace(thread) === "task")) {
			count++
			for (const step of span) threadSteps.add(step.id)
		}
		span = []
	}
	for (const step of steps) {
		if (step.kind === "task" || step.kind === "each") finish()
		else span.push(step)
	}
	finish()
	return { count, threadSteps }
}

/** The prompt a thread is sent before placeholders are filled. */
export function threadPrompt(step: AutomationThreadStep | AutomationTogetherStep, thread: AutomationThreadSpec): string {
	return step.kind === "together" && !thread.prompt.trim() ? step.prompt : thread.prompt
}

// ---------------------------------------------------------------------------
// Context from the user, and For each
// ---------------------------------------------------------------------------

/** Every text a step fills placeholders in. */
function stepTexts(step: AutomationStep): string[] {
	switch (step.kind) {
		case "task":
			return [step.title, step.ticket, step.newTaskTitle]
		case "thread":
			return [step.title, step.prompt]
		case "together":
			return [step.title, step.prompt, ...step.threads.flatMap((thread) => [thread.title, thread.prompt])]
		case "checkpoint":
			return [step.title, step.question]
		case "each":
			return [step.title, step.items, step.ticket, step.newTaskTitle]
	}
}

/**
 * Whether the automation puts `{{context}}` somewhere itself. When it does, the context goes only there;
 * otherwise every prompt thread gets it as a "Context from you" block after its prompt.
 */
export function placesContext(steps: readonly AutomationStep[]): boolean {
	return steps.some((step) =>
		stepTexts(step).some((text) =>
			placeholderRefs(text).some((ref) => ref.kind === "arg" && ref.name === CONTEXT_PLACEHOLDER),
		),
	)
}

/** A thread's prompt with the user's context after it, clearly marked as theirs. */
export function withContextBlock(prompt: string, context: string): string {
	const text = context.trim()
	return text ? `${prompt.trimEnd()}\n\n## Context from you\n\n${text}` : prompt
}

/** Index of the For each step, or -1. Steps after it run once per item. */
export function eachStepIndex(steps: readonly AutomationStep[]): number {
	return steps.findIndex((step) => step.kind === "each")
}

/**
 * The steps a run goes through: up to and including For each for a run of the whole automation, and
 * the steps after it for one item's run.
 */
export function stepsForRun(steps: readonly AutomationStep[], run?: Pick<AutomationRun, "parent">): readonly AutomationStep[] {
	if (run?.parent) {
		const at = steps.findIndex((step) => step.id === run.parent?.stepId && step.kind === "each")
		return at >= 0 ? steps.slice(at + 1) : []
	}
	const each = eachStepIndex(steps)
	return each >= 0 ? steps.slice(0, each + 1) : steps
}

/**
 * The list a For each step goes through: a JSON list, else one item per line (list markers dropped),
 * else a single line split at commas. Blank and repeated items are dropped.
 */
export function splitEachItems(text: string): string[] {
	const trimmed = text.trim()
	if (!trimmed) return []
	let items: string[] | undefined
	if (trimmed.startsWith("[")) {
		try {
			const parsed = JSON.parse(trimmed)
			if (Array.isArray(parsed)) items = parsed.map((item) => (typeof item === "string" ? item : JSON.stringify(item)))
		} catch {
			/* Not JSON: read it as lines. */
		}
	}
	if (!items) {
		const lines = trimmed.split(/\r?\n/).map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, ""))
		items = lines.filter((line) => line.trim()).length > 1 ? lines : trimmed.split(",")
	}
	return [...new Set(items.map((item) => item.trim()).filter(Boolean))]
}

/** A short name for an item in lists and task titles. */
export function eachItemLabel(item: string): string {
	return ticketKey(item)
}

// ---------------------------------------------------------------------------
// Validation (the builder shows these on the card; the store lists invalid files with them)
// ---------------------------------------------------------------------------

export interface AutomationIssue {
	/** The step (or argument, as `arg:name`) the issue belongs to; absent for the whole automation. */
	at?: string
	message: string
}

export function validateAutomation(definition: AutomationDefinition): AutomationIssue[] {
	const issues: AutomationIssue[] = []
	if (definition.costLimit !== undefined && !(definition.costLimit > 0))
		issues.push({ message: "The cost limit must be more than $0, or leave it empty" })
	if (!SCRIPT_NAME_REGEX.test(definition.name))
		issues.push({ message: 'Name must be lowercase letters, digits, "-" or "_" (it is typed as /name)' })
	else if ([...BASE_SLASH_COMMANDS, ...VSCODE_ONLY_COMMANDS].some((command) => command.name === definition.name))
		issues.push({ message: `/${definition.name} is already a Cline command; pick another name` })
	if (!definition.description.trim()) issues.push({ message: "Add a description: one line on what it does" })

	const argNames = new Set<string>()
	if (definition.arguments.length > MAX_ARGUMENTS) issues.push({ message: `At most ${MAX_ARGUMENTS} arguments` })
	for (const arg of definition.arguments) {
		const at = `arg:${arg.name}`
		if (!AUTOMATION_ARG_NAME_REGEX.test(arg.name))
			issues.push({ at, message: "Argument names are lowercase letters, digits, - or _, starting with a letter" })
		else if (argNames.has(arg.name)) issues.push({ at, message: `Argument "${arg.name}" is declared twice` })
		else if (RESERVED_ARG_NAMES.has(arg.name))
			issues.push({
				at,
				message:
					arg.name === "steps"
						? '"steps" is reserved for earlier steps'
						: `"${arg.name}" is reserved: {{${arg.name}}} is filled in for you`,
			})
		argNames.add(arg.name)
		if (!AUTOMATION_ARG_KINDS.includes(arg.kind)) issues.push({ at, message: `Argument "${arg.name}" has an unknown kind` })
		if (arg.kind === "choice" && !arg.choices?.length) issues.push({ at, message: `Argument "${arg.name}" needs choices` })
		if (arg.kind === "choice" && arg.default && !arg.choices?.includes(arg.default))
			issues.push({ at, message: `The default of "${arg.name}" isn't one of its choices` })
	}

	if (definition.steps.length === 0) issues.push({ message: "Add at least one step" })
	if (definition.steps.length > MAX_STEPS) issues.push({ message: `At most ${MAX_STEPS} steps` })

	const seen = new Map<string, AutomationStepKind>()
	const threads = new Map(automationThreads(definition.steps).map(({ thread }) => [thread.id, thread]))
	const stepIds = new Set(definition.steps.map((step) => step.id))
	const claim = (id: string, kind: AutomationStepKind) => {
		if (!AUTOMATION_ID_REGEX.test(id))
			issues.push({ at: id, message: `Step id "${id}" must be lowercase letters, digits or -` })
		else if (seen.has(id)) issues.push({ at: id, message: `Two steps are called "${id}"` })
		seen.set(id, kind)
	}
	// Whether the step being checked runs once per item (after For each), so `{{item}}` has a value.
	let perItem = false
	const checkText = (at: string, text: string, available: ReadonlySet<string>, item = perItem) => {
		for (const ref of placeholderRefs(text)) {
			if (ref.kind === "arg" && ref.name === ITEM_PLACEHOLDER && !argNames.has(ref.name)) {
				if (!item) issues.push({ at, message: `${ref.raw} only has a value in a For each step and the steps after it` })
				continue
			}
			if (ref.kind === "arg" && ref.name === CONTEXT_PLACEHOLDER) continue
			if (ref.kind === "arg" && !argNames.has(ref.name)) issues.push({ at, message: `${ref.raw} isn't an argument` })
			if (ref.kind === "step" && !available.has(ref.name)) {
				const [id, output, extra] = ref.name.split(".")
				const exists =
					output !== undefined
						? extra === undefined && threads.get(id)?.outputs?.some(({ name }) => name === output)
						: stepIds.has(id) || threads.has(id)
				issues.push({
					at,
					message: exists
						? `${ref.raw} runs later, so it has no ${output !== undefined ? "value" : "reply"} yet`
						: `${ref.raw} isn't ${output !== undefined ? "a declared output" : "a step"}`,
				})
			}
		}
	}
	const checkThread = (at: string, thread: AutomationThreadSpec, prompt: string, available: ReadonlySet<string>) => {
		if (!prompt.trim()) issues.push({ at, message: "Write the prompt" })
		if (thread.mode !== "ask" && thread.mode !== "act") issues.push({ at, message: "Mode must be Ask or Act" })
		checkText(at, prompt, available)
		checkText(at, thread.title, available)
		const names = new Set<string>()
		const outputs = thread.outputs ?? []
		if (outputs.length > MAX_OUTPUTS) issues.push({ at, message: `At most ${MAX_OUTPUTS} outputs` })
		for (const output of outputs) {
			if (!AUTOMATION_ARG_NAME_REGEX.test(output.name))
				issues.push({ at, message: "Output names start with a lowercase letter and use letters, digits, - or _" })
			else if (names.has(output.name)) issues.push({ at, message: `Output "${output.name}" is declared twice` })
			if (!output.description.trim()) issues.push({ at, message: `Describe what to record for output "${output.name}"` })
			names.add(output.name)
		}
	}

	// Outputs a step may use: every step (and together member) before it.
	const available = new Set<string>()
	definition.steps.forEach((step, index) => {
		claim(step.id, step.kind)
		switch (step.kind) {
			case "task":
				if (index !== 0) issues.push({ at: step.id, message: "Open a task must be the first step" })
				if (!step.ticket.trim()) issues.push({ at: step.id, message: "Say which ticket to find the task by" })
				checkText(step.id, step.ticket, available)
				checkText(step.id, step.newTaskTitle, available)
				break
			case "thread":
				checkThread(step.id, step, step.prompt, available)
				break
			case "together":
				if (step.threads.length < 2) issues.push({ at: step.id, message: "Threads together needs at least 2 threads" })
				if (step.threads.length > MAX_TOGETHER)
					issues.push({ at: step.id, message: `At most ${MAX_TOGETHER} threads together` })
				for (const thread of step.threads) {
					claim(thread.id, "thread")
					checkThread(thread.id, thread, threadPrompt(step, thread), available)
				}
				break
			case "checkpoint": {
				checkText(step.id, step.question, available)
				if (step.choicesFrom) {
					const source = definition.steps.find((candidate) => candidate.id === step.choicesFrom)
					const sourceIndex = definition.steps.findIndex((candidate) => candidate.id === step.choicesFrom)
					const each = eachStepIndex(definition.steps)
					if (!source || source.kind !== "together" || !available.has(source.id))
						issues.push({ at: step.id, message: "Choices must come from an earlier Threads together step" })
					else if (each >= 0 && index > each && sourceIndex < each)
						issues.push({ at: step.id, message: "Choices must come from a Threads together step after For each" })
				}
				break
			}
			case "each": {
				if (eachStepIndex(definition.steps) !== index)
					issues.push({ at: step.id, message: "Only one For each step: put every per-item step after the first" })
				if (index === definition.steps.length - 1)
					issues.push({ at: step.id, message: "Add the steps to run for each item after it" })
				if (!step.items.trim()) issues.push({ at: step.id, message: "Say which list to go through, like {{tickets}}" })
				if (!Number.isInteger(step.atOnce) || step.atOnce < 1 || step.atOnce > MAX_EACH_AT_ONCE)
					issues.push({ at: step.id, message: `Run 1 to ${MAX_EACH_AT_ONCE} items at once` })
				checkText(step.id, step.items, available, false)
				checkText(step.id, step.ticket, available, true)
				checkText(step.id, step.newTaskTitle, available, true)
				perItem = true
				break
			}
		}
		available.add(step.id)
		if (step.kind === "together") for (const thread of step.threads) available.add(thread.id)
		const specs = step.kind === "thread" ? [step] : step.kind === "together" ? step.threads : []
		for (const thread of specs) for (const output of thread.outputs ?? []) available.add(`${thread.id}.${output.name}`)
	})
	return issues
}

// ---------------------------------------------------------------------------
// Ids and blank steps for the builder
// ---------------------------------------------------------------------------

export function slugifyStepId(text: string): string {
	const slug = text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40)
	return /^[a-z]/.test(slug) ? slug : `step-${slug}`.replace(/-+$/, "")
}

/** An id not used yet: `base`, else `base-2`, `base-3`… */
export function uniqueStepId(base: string, steps: readonly AutomationStep[]): string {
	const used = new Set(steps.flatMap((step) => [step.id, ...(step.kind === "together" ? step.threads.map((t) => t.id) : [])]))
	const root = slugifyStepId(base) || "step"
	if (!used.has(root)) return root
	for (let n = 2; ; n++) if (!used.has(`${root}-${n}`)) return `${root}-${n}`
}

export function blankThread(id: string, title: string): AutomationThreadSpec {
	return { id, title, prompt: "", model: "", level: "", mode: "ask", worktree: false }
}

export function blankStep(kind: AutomationStepKind, steps: readonly AutomationStep[]): AutomationStep {
	switch (kind) {
		case "task":
			return { kind, id: uniqueStepId("task", steps), title: "Open the task", ticket: "{{ticket}}", newTaskTitle: "" }
		case "thread":
			return { kind, ...blankThread(uniqueStepId("thread", steps), "New thread") }
		case "together": {
			const id = uniqueStepId("together", steps)
			return {
				kind,
				id,
				title: "Together",
				prompt: "",
				threads: [blankThread(`${id}-a`, "Thread A"), blankThread(`${id}-b`, "Thread B")],
			}
		}
		case "checkpoint":
			return { kind, id: uniqueStepId("pick", steps), title: "Ask you", question: "", choicesFrom: "", choices: [] }
		case "each":
			return {
				kind,
				id: uniqueStepId("each", steps),
				title: "For each item",
				items: "",
				ticket: "",
				newTaskTitle: "",
				atOnce: DEFAULT_EACH_AT_ONCE,
			}
	}
}

export function emptyAutomation(): AutomationDefinition {
	return { name: "", title: "", description: "", arguments: [], steps: [] }
}

// ---------------------------------------------------------------------------
// Runs (wire types; the webview reads them from the run stream)
// ---------------------------------------------------------------------------

export type AutomationRunStatus = "running" | "waiting" | "done" | "failed" | "stopped"

/**
 * Where the fix for a problem lives: the run block and start form link there. "folder": no folder is
 * open; "repository": the folder isn't a git repository; "commit": the repository has no commits.
 */
export type AutomationFix = "worktrees" | "models" | "automation" | "folder" | "repository" | "commit"

/** Something that keeps a run (or a step) from going, in plain words, with where to fix it. */
export interface AutomationProblem {
	message: string
	fix?: AutomationFix
	/** The step it belongs to, when it's one step's problem. */
	stepId?: string
}
export type AutomationRunStepStatus = "pending" | "running" | "waiting" | "done" | "failed" | "stopped" | "skipped"

export interface RecordedAutomationOutput {
	name: string
	firstLine: string
	noteSlug?: string
}

export interface AutomationRunThread {
	/** The spec id from the definition. */
	id: string
	/** The thread it started; absent until it starts. */
	threadId?: string
	title: string
	model: string
	level: string
	mode: AutomationMode
	worktree: boolean
	worktreeScope?: ThreadWorkspaceChoice
	status: AutomationRunStepStatus
	/** Final reply (trimmed for the wire). */
	reply?: string
	error?: string
	fix?: AutomationFix
	/** While waiting: what it needs from the user ("Approve an edit to src/app.ts"). */
	waitingOn?: string
	declaredOutputs?: AutomationOutput[]
	outputs?: RecordedAutomationOutput[]
	missingOutputs?: string[]
}

/** One item of a For each step: its own run, in its own task. */
export interface AutomationRunItem {
	item: string
	/** Short name: a ticket key, else the first line. */
	label: string
	/** The item's run, once it started. */
	runId?: string
	taskGroupId?: string
	status: AutomationRunStepStatus
	/** The step it's on, or where it stopped. */
	at?: string
	/** Why it didn't finish (its run says more). */
	error?: string
}

export interface AutomationRunStep {
	id: string
	kind: AutomationStepKind
	title: string
	status: AutomationRunStepStatus
	threads: AutomationRunThread[]
	/** For each: every item with its run. */
	items?: AutomationRunItem[]
	/** Checkpoint: the question and its choices once known. */
	question?: string
	choices?: string[]
	choice?: string
	error?: string
	fix?: AutomationFix
}

export interface AutomationRun {
	id: string
	automation: string
	title: string
	values: Record<string, string>
	taskGroupId: string
	status: AutomationRunStatus
	steps: AutomationRunStep[]
	startedAt: number
	endedAt?: number
	error?: string
	fix?: AutomationFix
	/** When it was last resumed; time before that is in `priorMs`. */
	resumedAt?: number
	priorMs?: number
	/** Stops itself once its threads have spent this many dollars in all. */
	costLimit?: number
	/** What the user added when starting it. */
	context?: AutomationRunContext
	/** One item's run of a For each step: the run that fanned out, and which item. */
	parent?: AutomationRunParent
}

export interface AutomationRunContext {
	text: string
	/** Attached files, as paths. */
	files?: string[]
	/** How many images were attached (the images themselves stay on disk with the run). */
	images?: number
}

export interface AutomationRunParent {
	runId: string
	stepId: string
	item: string
	/** 0-based position in the list. */
	index: number
	total: number
}

export function isLiveRun(run: Pick<AutomationRun, "status">): boolean {
	return run.status === "running" || run.status === "waiting"
}

const subCentCost = new Intl.NumberFormat("en-US", { maximumSignificantDigits: 4, useGrouping: false })

export function formatAutomationCost(dollars: number): string {
	return `$${dollars > 0 && dollars < 0.01 ? subCentCost.format(dollars) : dollars.toFixed(2)}`
}

/** Thread ids a run started, in step order. */
export function runThreadIds(run: AutomationRun): string[] {
	return run.steps.flatMap((step) => step.threads.flatMap((thread) => (thread.threadId ? [thread.threadId] : [])))
}

/** Time the run has spent going, not counting the gap before a resume. */
export function runActiveMs(run: Pick<AutomationRun, "startedAt" | "endedAt" | "resumedAt" | "priorMs">, now: number): number {
	return (run.priorMs ?? 0) + Math.max(0, (run.endedAt ?? now) - (run.resumedAt ?? run.startedAt))
}

/** An already declared but unrecorded output was waived with Continue without. New outputs need a turn. */
export function hasNewAutomationOutputs(thread: AutomationRunThread | undefined, outputs?: readonly AutomationOutput[]): boolean {
	return (outputs ?? []).some(
		({ name }) =>
			!thread?.declaredOutputs?.some((output) => output.name === name) &&
			!thread?.outputs?.some((output) => output.name === name),
	)
}

/** Steps a finished run can resume from, up to the first step whose work can't be reused. */
export function resumePoints(run: AutomationRun, definition?: AutomationDefinition): { points: string[]; retryId?: string } {
	if (isLiveRun(run)) return { points: [] }
	const steps = definition ? stepsForRun(definition.steps, run) : run.steps
	const threads = definition ? automationThreads(definition.steps) : []
	const points: string[] = []
	for (const step of steps) {
		points.push(step.id)
		const prior = run.steps.find((candidate) => candidate.id === step.id && candidate.kind === step.kind)
		if (
			prior?.status !== "done" ||
			threads.some(
				({ step: parent, thread }) =>
					parent.id === step.id &&
					hasNewAutomationOutputs(
						prior.threads.find(({ id }) => id === thread.id),
						thread.outputs,
					),
			)
		)
			return { points, retryId: step.id }
	}
	return { points }
}
