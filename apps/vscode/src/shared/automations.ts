/**
 * Automations: a named recipe of steps the user starts with `/name` (never the agent). Steps open a
 * task, start prompt threads (alone or several together), and pause for the user. This module is shared
 * by the extension (file format, runtime) and the webview (builder, start form, run block), so it must
 * stay free of Node and DOM imports.
 */

import { SCRIPT_NAME_REGEX, type ScriptOption } from "./scripts"

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
	/** Run in a new worktree (Settings › Worktrees decides git or mm). */
	worktree: boolean
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

export type AutomationStep = AutomationTaskStep | AutomationThreadStep | AutomationTogetherStep | AutomationCheckpointStep
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
}

export const AUTOMATION_STEP_LABELS: Record<AutomationStepKind, string> = {
	task: "Open a task",
	thread: "Prompt thread",
	together: "Threads together",
	checkpoint: "Ask you",
}

export const AUTOMATION_ID_REGEX = /^[a-z][a-z0-9-]{0,47}$/
export const AUTOMATION_ARG_NAME_REGEX = /^[a-z][a-z0-9_-]{0,47}$/
const MAX_ARGUMENTS = 20
const MAX_STEPS = 40
const MAX_TOGETHER = 8

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

/** The prompt a thread is sent before placeholders are filled. */
export function threadPrompt(step: AutomationThreadStep | AutomationTogetherStep, thread: AutomationThreadSpec): string {
	return step.kind === "together" && !thread.prompt.trim() ? step.prompt : thread.prompt
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
	if (!definition.description.trim()) issues.push({ message: "Add a description: one line on what it does" })

	const argNames = new Set<string>()
	if (definition.arguments.length > MAX_ARGUMENTS) issues.push({ message: `At most ${MAX_ARGUMENTS} arguments` })
	for (const arg of definition.arguments) {
		const at = `arg:${arg.name}`
		if (!AUTOMATION_ARG_NAME_REGEX.test(arg.name))
			issues.push({ at, message: "Argument names are lowercase letters, digits, - or _, starting with a letter" })
		else if (argNames.has(arg.name)) issues.push({ at, message: `Argument "${arg.name}" is declared twice` })
		else if (arg.name === "steps") issues.push({ at, message: '"steps" is reserved for earlier steps' })
		argNames.add(arg.name)
		if (!AUTOMATION_ARG_KINDS.includes(arg.kind)) issues.push({ at, message: `Argument "${arg.name}" has an unknown kind` })
		if (arg.kind === "choice" && !arg.choices?.length) issues.push({ at, message: `Argument "${arg.name}" needs choices` })
		if (arg.kind === "choice" && arg.default && !arg.choices?.includes(arg.default))
			issues.push({ at, message: `The default of "${arg.name}" isn't one of its choices` })
	}

	if (definition.steps.length === 0) issues.push({ message: "Add at least one step" })
	if (definition.steps.length > MAX_STEPS) issues.push({ message: `At most ${MAX_STEPS} steps` })

	const seen = new Map<string, AutomationStepKind>()
	const claim = (id: string, kind: AutomationStepKind) => {
		if (!AUTOMATION_ID_REGEX.test(id))
			issues.push({ at: id, message: `Step id "${id}" must be lowercase letters, digits or -` })
		else if (seen.has(id)) issues.push({ at: id, message: `Two steps are called "${id}"` })
		seen.set(id, kind)
	}
	const checkText = (at: string, text: string, available: ReadonlySet<string>) => {
		for (const ref of placeholderRefs(text)) {
			if (ref.kind === "arg" && !argNames.has(ref.name)) issues.push({ at, message: `${ref.raw} isn't an argument` })
			if (ref.kind === "step" && !available.has(ref.name)) {
				const later = definition.steps.some(
					(step) => step.id === ref.name || (step.kind === "together" && step.threads.some((t) => t.id === ref.name)),
				)
				issues.push({ at, message: later ? `${ref.raw} runs later, so it has no reply yet` : `${ref.raw} isn't a step` })
			}
		}
	}
	const checkThread = (at: string, thread: AutomationThreadSpec, prompt: string, available: ReadonlySet<string>) => {
		if (!prompt.trim()) issues.push({ at, message: "Write the prompt" })
		if (thread.mode !== "ask" && thread.mode !== "act") issues.push({ at, message: "Mode must be Ask or Act" })
		checkText(at, prompt, available)
		checkText(at, thread.title, available)
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
					if (!source || source.kind !== "together" || !available.has(source.id))
						issues.push({ at: step.id, message: "Choices must come from an earlier Threads together step" })
				}
				break
			}
		}
		available.add(step.id)
		if (step.kind === "together") for (const thread of step.threads) available.add(thread.id)
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
	}
}

export function emptyAutomation(): AutomationDefinition {
	return { name: "", title: "", description: "", arguments: [], steps: [] }
}

// ---------------------------------------------------------------------------
// Runs (wire types; the webview reads them from the run stream)
// ---------------------------------------------------------------------------

export type AutomationRunStatus = "running" | "waiting" | "done" | "failed" | "stopped"

/** Where the fix for a problem lives: the run block and start form link there. */
export type AutomationFix = "worktrees" | "models" | "automation"

/** Something that keeps a run (or a step) from going, in plain words, with where to fix it. */
export interface AutomationProblem {
	message: string
	fix?: AutomationFix
	/** The step it belongs to, when it's one step's problem. */
	stepId?: string
}
export type AutomationRunStepStatus = "pending" | "running" | "waiting" | "done" | "failed" | "stopped" | "skipped"

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
	status: AutomationRunStepStatus
	/** Final reply (trimmed for the wire). */
	reply?: string
	error?: string
	fix?: AutomationFix
	/** While waiting: what it needs from the user ("Approve an edit to src/app.ts"). */
	waitingOn?: string
}

export interface AutomationRunStep {
	id: string
	kind: AutomationStepKind
	title: string
	status: AutomationRunStepStatus
	threads: AutomationRunThread[]
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
}

export function isLiveRun(run: Pick<AutomationRun, "status">): boolean {
	return run.status === "running" || run.status === "waiting"
}

/** Thread ids a run started, in step order. */
export function runThreadIds(run: AutomationRun): string[] {
	return run.steps.flatMap((step) => step.threads.flatMap((thread) => (thread.threadId ? [thread.threadId] : [])))
}

/** Time the run has spent going, not counting the gap before a resume. */
export function runActiveMs(run: Pick<AutomationRun, "startedAt" | "endedAt" | "resumedAt" | "priorMs">, now: number): number {
	return (run.priorMs ?? 0) + Math.max(0, (run.endedAt ?? now) - (run.resumedAt ?? run.startedAt))
}

/**
 * Steps a finished run can go on from, in order: each one whose earlier steps all finished. The last is
 * the first step that didn't finish (Retry). With the automation's current definition, a step must still
 * be there (same id and kind) for its finished work to be kept.
 */
export function resumePoints(run: AutomationRun, definition?: AutomationDefinition): string[] {
	if (isLiveRun(run)) return []
	const steps = definition?.steps ?? run.steps
	const points: string[] = []
	for (const step of steps) {
		points.push(step.id)
		const prior = run.steps.find((candidate) => candidate.id === step.id && candidate.kind === step.kind)
		if (prior?.status !== "done") break
	}
	// A run where every step finished can redo any step, but there's nothing to retry.
	return points
}

/** The first step that didn't finish: what Retry runs again. */
export function retryPoint(run: AutomationRun): AutomationRunStep | undefined {
	if (isLiveRun(run)) return undefined
	return run.steps.find((step) => step.status !== "done")
}
