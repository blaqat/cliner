import {
	type AutomationDefinition,
	type AutomationEachStep,
	type AutomationFix,
	type AutomationOutput,
	type AutomationProblem,
	type AutomationRun,
	type AutomationRunItem,
	type AutomationRunStatus,
	type AutomationRunStep,
	type AutomationRunThread,
	type AutomationStep,
	type AutomationThreadSpec,
	type AutomationThreadStep,
	type AutomationTogetherStep,
	automationDisplayName,
	automationTaskWorktrees,
	automationWorkspace,
	CONTEXT_PLACEHOLDER,
	DEFAULT_EACH_AT_ONCE,
	eachItemLabel,
	fillPlaceholders,
	formatAutomationCost,
	hasNewAutomationOutputs,
	ITEM_PLACEHOLDER,
	isLiveRun,
	MAX_EACH_AT_ONCE,
	MAX_EACH_ITEMS,
	placeholderRefs,
	placesContext,
	resumePoints,
	runActiveMs,
	splitEachItems,
	stepsForRun,
	threadPrompt,
	ticketKey,
	withArgumentDefaults,
	withContextBlock,
} from "@shared/automations"
import type { ClineMessage } from "@shared/ExtensionMessage"
import type { ThreadWorkspaceChoice } from "@shared/thread-worktrees"

/** A failure with a known fix ("Worktrees settings"); the run block links there. */
export class AutomationFixableError extends Error {
	constructor(
		message: string,
		readonly fix: AutomationFix,
	) {
		super(message)
	}
}

/** The pre-check found something to fix before anything runs. */
export class AutomationCheckError extends Error {
	constructor(readonly problems: AutomationProblem[]) {
		super(problems.map((problem) => problem.message).join(" "))
	}
}

/**
 * A finished run as kept on disk: the wire run plus every step's full reply and the images the user
 * attached, so a resume can use them.
 */
export type StoredAutomationRun = AutomationRun & {
	outputs?: Record<string, string>
	contextText?: string
	contextImages?: string[]
}

/** What the user adds when starting a run: text, and attachments the composer allows. */
export interface AutomationStartContext {
	text?: string
	images?: string[]
	files?: string[]
}

/** How a run thread's turn ended, from its messages. */
export type ThreadTurnEnd = { kind: "done"; reply: string } | { kind: "waiting" }

/** Longest reply kept on the wire for the run block; placeholders get the whole reply. */
const WIRE_REPLY_CHARS = 600
/** Finished runs kept for the task page. */
const KEPT_RUNS = 50

function responseText(text: string | undefined): string {
	try {
		const parsed = JSON.parse(text ?? "")
		if (typeof parsed?.response === "string") return parsed.response
	} catch {
		/* Plain text. */
	}
	return text ?? ""
}

/**
 * What a thread said last when its turn ended. A question for the user means it's waiting (the step
 * goes on once it's answered); otherwise its last reply (completion, Ask-mode response or text) is the
 * step's output.
 */
export function classifyTurnEnd(messages: readonly ClineMessage[]): ThreadTurnEnd {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index]
		if (message.partial) continue
		if (message.type === "ask") {
			if (message.ask === "followup") return { kind: "waiting" }
			if (message.ask === "plan_mode_respond" || message.ask === "act_mode_respond")
				return { kind: "done", reply: responseText(message.text).trim() }
			if (message.ask === "completion_result" && message.text?.trim()) return { kind: "done", reply: message.text.trim() }
			continue
		}
		if (["completion_result", "plan_completion_result", "text"].includes(message.say ?? "") && message.text?.trim())
			return { kind: "done", reply: message.text.trim() }
	}
	return { kind: "done", reply: "" }
}

export interface StartThreadInput {
	runId: string
	taskGroupId: string
	title: string
	prompt: string
	model: string
	level: string
	mode: "ask" | "act"
	worktree: boolean
	worktreeScope?: ThreadWorkspaceChoice
	/** Attached with the user's context, on the threads that get it. */
	images?: string[]
	files?: string[]
	onSessionId?: (id: string) => void
}

export interface AutomationThreadState {
	status: "running" | "waiting" | "done" | "error" | "stopped"
	messages: readonly ClineMessage[]
	cancelled: boolean
}

export interface AutomationRunnerDeps {
	/** The task tagged with this ticket, else a new one with that tag. */
	findOrCreateTask: (ticket: string, title: string) => Promise<string>
	/** A new task for a run that has no task to run in. */
	createTask: (title: string, ticket?: string) => Promise<string>
	/** Starts a background thread in the task; resolves to its id. Throws with a reason the user can act on. */
	startThread: (input: StartThreadInput) => Promise<string>
	/** Current state after startup, which may have outlasted the thread's first turn. */
	readThreadState?: (threadId: string) => AutomationThreadState | undefined
	stopThread: (threadId: string) => Promise<void>
	askForOutputs?: (threadId: string, names: string[]) => Promise<void>
	saveOutputNote?: (
		groupId: string,
		thread: { threadId: string; title: string },
		output: AutomationOutput,
		value: string,
	) => Promise<string>
	/**
	 * What must be fixed before these steps can run (a worktree that can't be made, no folder open).
	 * Start and resume call it first, so nothing runs when it finds a problem.
	 */
	precheck?: (steps: readonly AutomationStep[], taskGroupId?: string) => Promise<AutomationProblem[]>
	/** Makes sure a run thread keeps the step's title once its turn ends. */
	nameThread?: (threadId: string, title: string) => Promise<void>
	/** What a waiting thread needs from the user, in a few words ("Approve an edit to src/app.ts"). */
	describeWaiting?: (threadId: string) => string | undefined
	/** Dollars a thread has spent so far; undefined once it's no longer loaded. */
	threadCost?: (threadId: string) => number | undefined
	onChange: (runs: readonly AutomationRun[]) => void
	load?: () => Promise<StoredAutomationRun[]>
	save?: (runs: readonly StoredAutomationRun[]) => Promise<void>
	now?: () => number
	newId?: () => string
}

type ThreadOutcome =
	| { kind: "done"; reply: string }
	| { kind: "failed"; error: string; fix?: AutomationFix }
	| { kind: "stopped" }

interface LiveRun {
	run: AutomationRun
	stopped: boolean
	/** Full replies by step or thread id (the wire copy is trimmed). */
	outputs: Record<string, string>
	/** Checkpoint answers waiting by step id. */
	answers: Map<string, (choice: string) => void>
	/** Spent before this go (a resume allows the limit again). */
	costBase: number
	keepNotes?: boolean
	/** The user's context; `placed` when the automation puts `{{context}}` itself. */
	context: { text: string; images: string[]; files: string[]; placed: boolean }
}

/** The longest context kept on the wire for the run block; threads get all of it. */
const WIRE_CONTEXT_CHARS = 2000

/** How often a run with a cost limit checks what its threads spent. */
const COST_POLL_MS = 3000

function trimReply(reply: string): string {
	return reply.length > WIRE_REPLY_CHARS ? `${reply.slice(0, WIRE_REPLY_CHARS).trimEnd()}…` : reply
}

function runThreadFor(spec: AutomationThreadSpec): AutomationRunThread {
	return {
		id: spec.id,
		title: spec.title,
		model: spec.model,
		level: spec.level,
		mode: spec.mode,
		worktree: spec.worktree,
		...(spec.worktreeScope ? { worktreeScope: spec.worktreeScope } : {}),
		status: "pending",
		...(spec.outputs?.length ? { declaredOutputs: spec.outputs } : {}),
	}
}

function runStepFor(step: AutomationStep): AutomationRunStep {
	switch (step.kind) {
		case "thread":
			return { id: step.id, kind: step.kind, title: step.title, status: "pending", threads: [runThreadFor(step)] }
		case "together":
			return { id: step.id, kind: step.kind, title: step.title, status: "pending", threads: step.threads.map(runThreadFor) }
		case "checkpoint":
			return { id: step.id, kind: step.kind, title: step.title, status: "pending", threads: [] }
		case "task":
			return { id: step.id, kind: step.kind, title: step.title, status: "pending", threads: [] }
		case "each":
			return { id: step.id, kind: step.kind, title: step.title, status: "pending", threads: [], items: [] }
	}
}

function wireContext(context: AutomationStartContext): AutomationRun["context"] {
	const text = context.text?.trim() ?? ""
	if (!text && !context.images?.length && !context.files?.length) return undefined
	return {
		text: text.length > WIRE_CONTEXT_CHARS ? `${text.slice(0, WIRE_CONTEXT_CHARS).trimEnd()}…` : text,
		...(context.files?.length ? { files: [...context.files] } : {}),
		...(context.images?.length ? { images: context.images.length } : {}),
	}
}

/** Placeholder values every step gets besides the arguments: the context, and the item in a For each. */
function runArgs(args: Record<string, string>, context: string, parent?: AutomationRun["parent"]): Record<string, string> {
	return { ...args, [CONTEXT_PLACEHOLDER]: context, ...(parent ? { [ITEM_PLACEHOLDER]: parent.item } : {}) }
}

/** An item's status from its run's. */
function itemStatus(status: AutomationRunStatus): AutomationRunItem["status"] {
	return status
}

function costStopMessage(limit: number, spent: string): string {
	const formattedLimit = formatAutomationCost(limit)
	return `Stopped at its ${formattedLimit} cost limit (${spent} spent). Resume to allow another ${formattedLimit}.`
}

function restoreCostStopMessage(run: AutomationRun): AutomationRun {
	if (run.status !== "stopped" || !run.costLimit || run.costLimit >= 0.01 || !run.error) return run
	// Old runs saved the exact limit and only the rounded spend in the stop message.
	const legacy =
		/^Stopped at its \$\d+\.\d{2} cost limit \(\$(\d+\.\d{2}) spent\)\. Resume to allow another \$\d+\.\d{2}\.$/.exec(
			run.error,
		)
	if (!legacy) return run
	const spent = Number(legacy[1])
	return {
		...run,
		error: costStopMessage(run.costLimit, spent ? formatAutomationCost(spent) : `less than ${formatAutomationCost(0.01)}`),
	}
}

/**
 * Runs automations: one step after another, a together step's threads at the same time, a checkpoint
 * waits for the user's pick. Every thread is a normal background thread in the run's task, so the user
 * can open it and type in it; the step finishes when its thread's turn ends with a reply. Only the user
 * starts a run (the composer's `/name`): no agent tool reaches this.
 */
export class AutomationRunner {
	private readonly live = new Map<string, LiveRun>()
	private readonly resuming = new Set<string>()
	private runs: AutomationRun[] = []
	private readonly waiting = new Map<
		string,
		{ runId: string; resolve: (outcome: ThreadOutcome) => void; reply?: string; askingAgain?: boolean }
	>()
	/** Full replies of every run's steps, by run id (the wire copy is trimmed). */
	private readonly outputs = new Map<string, Record<string, string>>()
	/** The user's full context text and images, by run id (the wire copy is trimmed and counts images). */
	private readonly contexts = new Map<string, { text: string; images: string[] }>()
	/** Last known spend per thread, for threads no longer loaded. */
	private readonly costs = new Map<string, number>()
	private costTimer: ReturnType<typeof setInterval> | undefined
	private loaded: Promise<void> | undefined

	constructor(private readonly deps: AutomationRunnerDeps) {}

	private now(): number {
		return this.deps.now?.() ?? Date.now()
	}

	private newId(): string {
		return this.deps.newId?.() ?? `run-${this.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
	}

	/** Earlier runs from disk. A run that was going when VS Code closed shows as stopped; Resume picks it up. */
	load(): Promise<void> {
		this.loaded ??= (async () => {
			const stored = (await this.deps.load?.().catch(() => [])) ?? []
			const known = new Set(this.runs.map((run) => run.id))
			const restored = stored
				.filter((run) => !known.has(run.id))
				.map(({ outputs, contextText, contextImages, ...run }): AutomationRun => {
					if (outputs) this.outputs.set(run.id, outputs)
					if (contextText !== undefined || contextImages?.length)
						this.contexts.set(run.id, { text: contextText ?? run.context?.text ?? "", images: contextImages ?? [] })
					return restoreCostStopMessage(run)
				})
				.map((run) =>
					isLiveRun(run)
						? {
								...run,
								status: "stopped" as const,
								endedAt: run.endedAt ?? this.now(),
								error: "VS Code closed while it ran. Finished steps are kept: resume to go on.",
								steps: run.steps.map((step) =>
									step.status === "running" || step.status === "waiting" || step.status === "pending"
										? {
												...step,
												status: step.status === "pending" ? ("skipped" as const) : ("stopped" as const),
												...(step.items
													? {
															items: step.items.map((item) =>
																item.status === "pending"
																	? { ...item, status: "skipped" as const }
																	: item.status === "running" || item.status === "waiting"
																		? { ...item, status: "stopped" as const }
																		: item,
															),
														}
													: {}),
												threads: step.threads.map((thread) => {
													if (thread.status === "pending")
														return { ...thread, status: "skipped" as const }
													if (thread.status !== "waiting" && thread.status !== "running") return thread
													return {
														...thread,
														status: "stopped" as const,
														waitingOn: undefined,
														missingOutputs: undefined,
													}
												}),
											}
										: step,
								),
							}
						: run,
				)
			this.runs = [...this.runs, ...restored]
		})()
		return this.loaded
	}

	list(): readonly AutomationRun[] {
		return this.runs
	}

	/** The run that started this thread, if any. */
	runForThread(threadId: string): AutomationRun | undefined {
		return this.runs.find((run) => run.steps.some((step) => step.threads.some((thread) => thread.threadId === threadId)))
	}

	noteGroupToKeep(threadId: string): string | undefined {
		const found = this.threadOf(threadId)
		if (
			found &&
			!found.live.stopped &&
			found.live.keepNotes &&
			(found.thread.status === "running" || found.thread.status === "waiting")
		)
			return found.live.run.taskGroupId
		return undefined
	}

	outputValue(runId: string, stepId: string, name: string): string {
		const value = this.outputs.get(runId)?.[`${stepId}.${name}`]
		if (value === undefined) throw new Error("That output is no longer available.")
		return value
	}

	private changed(): void {
		this.syncItems()
		this.runs = this.runs.map((run) => {
			const live = this.live.get(run.id)
			if (live) this.outputs.set(run.id, live.outputs)
			return live ? structuredClone(live.run) : run
		})
		this.deps.onChange(this.runs)
		const kept = this.runs.slice(-KEPT_RUNS)
		void this.deps
			.save?.(
				kept.map((run) => {
					const context = this.contexts.get(run.id)
					return {
						...run,
						outputs: { ...this.outputs.get(run.id) },
						...(context && context.text !== (run.context?.text ?? "") ? { contextText: context.text } : {}),
						...(context?.images.length ? { contextImages: context.images } : {}),
					}
				}),
			)
			.catch(() => {})
	}

	/** A run by id, live first. */
	private runById(id: string): AutomationRun | undefined {
		return this.live.get(id)?.run ?? this.runs.find((run) => run.id === id)
	}

	/**
	 * Brings each For each step's items up to date with their runs (an item's run can also be resumed on
	 * its own task page). A finished fan-out whose last unfinished item then finishes is done.
	 */
	private syncItems(): void {
		const sync = (run: AutomationRun): boolean => {
			let touched = false
			for (const step of run.steps) {
				for (const item of step.items ?? []) {
					const child = item.runId ? this.runById(item.runId) : undefined
					if (!child) continue
					const at = child.steps.find((candidate) => candidate.status !== "done" && candidate.status !== "pending")
					const failed = child.steps.find((candidate) => candidate.status === "failed")
					const next = {
						status: itemStatus(child.status),
						at: at ? at.title : undefined,
						error:
							child.status === "failed" || child.status === "stopped"
								? (failed?.threads.find((thread) => thread.error)?.error ?? failed?.error ?? child.error)
								: undefined,
					}
					if (item.status === next.status && item.at === next.at && item.error === next.error) continue
					Object.assign(item, next)
					touched = true
				}
			}
			return touched
		}
		for (const live of this.live.values()) if (sync(live.run)) this.syncStatus(live)
		this.runs = this.runs.map((run) => {
			if (this.live.has(run.id) || !run.steps.some((step) => step.items?.some((item) => item.runId))) return run
			const copy = structuredClone(run)
			if (!sync(copy)) return run
			const each = copy.steps.find((step) => step.kind === "each")
			if (each?.items?.length && each.items.every((item) => item.status === "done") && !isLiveRun(copy)) {
				each.status = "done"
				each.error = undefined
				each.fix = undefined
				if (copy.steps.every((step) => step.status === "done")) {
					copy.status = "done"
					copy.error = undefined
					copy.fix = undefined
				}
			}
			return copy
		})
	}

	private async precheck(steps: readonly AutomationStep[], taskGroupId?: string): Promise<void> {
		const problems = (await this.deps.precheck?.(steps, taskGroupId)) ?? []
		if (problems.length) throw new AutomationCheckError(problems)
	}

	/** Checks the steps the requested action will run in this task. Items are checked in their own tasks. */
	async checkResume(
		run: AutomationRun,
		definition: AutomationDefinition,
		{ stepId, fresh }: { stepId?: string; fresh?: boolean },
	): Promise<AutomationProblem[]> {
		const steps = stepsForRun(definition.steps, run)
		const fromId = stepId || resumePoints(run, definition).retryId
		const fromIndex = fresh ? 0 : steps.findIndex((step) => step.id === fromId)
		if (fromIndex < 0) return []
		return (await this.deps.precheck?.(steps.slice(fromIndex), run.taskGroupId)) ?? []
	}

	/**
	 * Starts a run. `taskGroupId` is the task the user started it in; without one (and without an
	 * Open a task step) the run makes a task named after the automation.
	 */
	async start(
		definition: AutomationDefinition,
		values: Readonly<Record<string, string>>,
		options: { taskGroupId?: string; context?: AutomationStartContext } = {},
	): Promise<AutomationRun> {
		await this.load()
		const args = withArgumentDefaults(definition.arguments, values)
		const missing = definition.arguments.filter((arg) => arg.required && !args[arg.name])
		if (missing.length) throw new Error(`Needs ${missing.map((arg) => arg.name).join(", ")}`)
		const steps = stepsForRun(definition.steps)
		await this.precheck(steps, options.taskGroupId)
		const run: AutomationRun = {
			id: this.newId(),
			automation: definition.name,
			title: automationDisplayName(definition),
			values: args,
			taskGroupId: options.taskGroupId ?? "",
			status: "running",
			steps: steps.map(runStepFor),
			startedAt: this.now(),
			...(definition.costLimit ? { costLimit: definition.costLimit } : {}),
		}
		const context = wireContext(options.context ?? {})
		if (context) run.context = context
		const fullContext = { text: options.context?.text?.trim() ?? "", images: [...(options.context?.images ?? [])] }
		// The first step that needs a task decides it: an Open a task step, or a task made now.
		if (!run.taskGroupId && definition.steps[0]?.kind !== "task") {
			const ticketArg = definition.arguments.find((arg) => arg.kind === "ticket" && args[arg.name])
			const ticket = ticketArg ? ticketKey(args[ticketArg.name]) : undefined
			run.taskGroupId = await this.deps.createTask(ticket ? `${run.title} · ${ticket}` : run.title, ticket)
		}
		const live: LiveRun = {
			run,
			stopped: false,
			outputs: {},
			answers: new Map(),
			costBase: 0,
			keepNotes: definition.keepNotes,
			context: { ...fullContext, files: context?.files ?? [], placed: placesContext(definition.steps) },
		}
		if (context) this.contexts.set(run.id, fullContext)
		this.live.set(run.id, live)
		this.runs = [...this.runs, structuredClone(run)]
		this.changed()
		void this.execute(live, definition, steps, runArgs(args, fullContext.text), 0)
		return structuredClone(run)
	}

	/**
	 * Goes on with a finished run (failed, stopped, or done) from one of its steps, using the automation as
	 * it is now, so a fix to the file counts. Steps before `fromStepId` keep their threads and replies;
	 * without it, the first step that didn't finish runs again (Retry), keeping any of its threads that
	 * already replied. Checks the workspace first, so nothing changes when something still needs fixing.
	 */
	async resume(runId: string, definition: AutomationDefinition, fromStepId?: string): Promise<AutomationRun> {
		// Reserve before even loading: two requests must not pass the precheck together.
		if (this.resuming.has(runId)) throw new Error("That run is already running.")
		this.resuming.add(runId)
		try {
			await this.load()
			const prior = this.runs.find((run) => run.id === runId)
			if (!prior) throw new Error("That run is gone. Start the automation again.")
			if (this.live.has(runId) || isLiveRun(prior)) throw new Error("That run is already running.")
			const busyItem = this.itemRuns(prior).find(
				(child) => this.live.has(child.id) || this.resuming.has(child.id) || isLiveRun(child),
			)
			if (busyItem)
				throw new Error(
					`${busyItem.parent ? eachItemLabel(busyItem.parent.item) : "An item"} is still running. Wait for it or stop it first.`,
				)
			if (prior.parent && (this.live.has(prior.parent.runId) || this.resuming.has(prior.parent.runId)))
				throw new Error("The run this item belongs to is still going. Stop it first, or let it retry this item.")
			const resumed = this.prepareResume(prior, definition, fromStepId)
			await this.precheck(resumed.steps.slice(resumed.fromIndex), prior.taskGroupId)
			this.live.set(prior.id, resumed.live)
			this.changed()
			void this.execute(resumed.live, definition, resumed.steps, resumed.args, resumed.fromIndex)
			return structuredClone(resumed.live.run)
		} finally {
			this.resuming.delete(runId)
		}
	}

	/** The runs of a run's For each items. */
	private itemRuns(run: AutomationRun): AutomationRun[] {
		return run.steps.flatMap((step) =>
			(step.items ?? []).flatMap((item) => {
				const child = item.runId ? this.runById(item.runId) : undefined
				return child ? [child] : []
			}),
		)
	}

	/**
	 * A finished run made ready to go on from a step (or, without one, the first step that didn't finish),
	 * with the automation as it is now. Steps before that keep their threads and replies; a retried
	 * together step keeps threads that replied, and a retried For each keeps items that finished.
	 */
	private prepareResume(
		prior: AutomationRun,
		definition: AutomationDefinition,
		fromStepId?: string,
	): { live: LiveRun; steps: readonly AutomationStep[]; args: Record<string, string>; fromIndex: number } {
		const steps = stepsForRun(definition.steps, prior)
		if (prior.parent && !steps.length)
			throw new Error("The automation no longer has this For each step. Start the automation again.")
		const { points, retryId } = resumePoints(prior, definition)
		const fromId = fromStepId ?? retryId
		const fromIndex = steps.findIndex((step) => step.id === fromId)
		if (fromIndex < 0 || !points.includes(fromId as string))
			throw new Error(
				fromStepId
					? "That step can't run yet: a step before it didn't finish, or the automation changed. Resume from an earlier step."
					: "Every step of this run finished. Use Run again for a fresh run.",
			)
		const args = withArgumentDefaults(definition.arguments, prior.values)
		const missing = definition.arguments.filter((arg) => arg.required && !args[arg.name])
		if (missing.length)
			throw new Error(`The automation now needs ${missing.map((arg) => arg.name).join(", ")}. Use Run again.`)

		const priorOutputs = this.outputs.get(prior.id) ?? {}
		const outputs: Record<string, string> = {}
		// An item's run starts with the replies of the steps before For each: keep those.
		if (prior.parent) {
			const own = new Set(
				steps.flatMap((step) => [step.id, ...(step.kind === "together" ? step.threads.map((t) => t.id) : [])]),
			)
			for (const [key, value] of Object.entries(priorOutputs)) if (!own.has(key.split(".")[0])) outputs[key] = value
		}
		const keepThreadOutputs = (thread: AutomationRunThread) => {
			outputs[thread.id] = priorOutputs[thread.id] ?? thread.reply ?? ""
			for (const output of thread.outputs ?? []) {
				const key = `${thread.id}.${output.name}`
				if (priorOutputs[key] !== undefined) outputs[key] = priorOutputs[key]
			}
		}
		const retrying = (kept: AutomationRunStep | undefined, index: number): kept is AutomationRunStep =>
			index === fromIndex &&
			fromStepId === undefined &&
			fromId === retryId &&
			(prior.status === "failed" || prior.status === "stopped") &&
			(kept?.status === "failed" || kept?.status === "stopped")
		const runSteps = steps.map((step, index): AutomationRunStep => {
			const kept = prior.steps.find((candidate) => candidate.id === step.id && candidate.kind === step.kind)
			if (index < fromIndex && kept) {
				outputs[step.id] = priorOutputs[step.id] ?? ""
				for (const thread of kept.threads) keepThreadOutputs(thread)
				return structuredClone(kept)
			}
			const fresh = runStepFor(step)
			// Retrying a together step keeps the threads that already replied; only the others start again.
			if (retrying(kept, index) && step.kind === "together") {
				fresh.threads = fresh.threads.map((thread) => {
					const done = kept.threads.find((candidate) => candidate.id === thread.id && candidate.status === "done")
					if (!done || priorOutputs[thread.id] === undefined || hasNewAutomationOutputs(done, thread.declaredOutputs))
						return thread
					keepThreadOutputs(done)
					return structuredClone(done)
				})
			}
			// Retrying a For each keeps every item and its run: finished ones stay, the others go on.
			if (retrying(kept, index) && step.kind === "each") fresh.items = structuredClone(kept.items ?? [])
			return fresh
		})
		const now = this.now()
		const run: AutomationRun = {
			...structuredClone(prior),
			title: automationDisplayName(definition),
			values: args,
			status: "running",
			steps: runSteps,
			priorMs: runActiveMs(prior, now),
			resumedAt: now,
			endedAt: undefined,
			error: undefined,
			fix: undefined,
			...(definition.costLimit ? { costLimit: definition.costLimit } : { costLimit: undefined }),
		}
		const context = this.contexts.get(prior.id) ?? { text: prior.context?.text ?? "", images: [] }
		const live: LiveRun = {
			run,
			stopped: false,
			outputs,
			answers: new Map(),
			costBase: this.spent(run),
			keepNotes: definition.keepNotes,
			context: { ...context, files: prior.context?.files ?? [], placed: placesContext(definition.steps) },
		}
		return { live, steps, args: runArgs(args, context.text, prior.parent), fromIndex }
	}

	/** A fresh run of a finished one: same values, same task. */
	async runAgain(runId: string, definition: AutomationDefinition): Promise<AutomationRun> {
		await this.load()
		const prior = this.runs.find((run) => run.id === runId)
		if (!prior) throw new Error("That run is gone. Start the automation again.")
		// One item's run goes again from its first step, in its task, still part of its fan-out.
		if (prior.parent) {
			const first = stepsForRun(definition.steps, prior)[0]
			if (!first) throw new Error("The automation no longer has this For each step. Start the automation again.")
			return this.resume(runId, definition, first.id)
		}
		const context = this.contexts.get(runId)
		return this.start(definition, prior.values, {
			taskGroupId: prior.taskGroupId || undefined,
			context: { text: context?.text ?? prior.context?.text, images: context?.images, files: prior.context?.files },
		})
	}

	/**
	 * Runs `steps` (the run's part of the automation) from `fromIndex`. `args` holds the arguments plus
	 * `context`, and `item` in an item's run.
	 */
	private async execute(
		live: LiveRun,
		definition: AutomationDefinition,
		steps: readonly AutomationStep[],
		args: Record<string, string>,
		fromIndex: number,
		checkItemWorkspace = false,
	): Promise<void> {
		const { run } = live
		const fill = (text: string) => fillPlaceholders(text, { args, outputs: live.outputs })
		const { threadSteps: taskWorktreeSteps } = automationTaskWorktrees(steps)
		this.watchCosts()
		try {
			if (checkItemWorkspace) await this.precheck(steps.slice(fromIndex), run.taskGroupId)
			for (const [index, step] of steps.entries()) {
				if (index < fromIndex) continue
				if (live.stopped) break
				const runStep = run.steps[index]
				const useTaskWorktree = taskWorktreeSteps.has(step.id)
				runStep.title = fill(step.title) || step.id
				runStep.status = "running"
				this.changed()
				switch (step.kind) {
					case "task": {
						const ticket = fill(step.ticket).trim()
						if (!ticket) throw new Error("No ticket to find the task by. Fill in the ticket and run it again.")
						const key = ticketKey(ticket)
						run.taskGroupId = await this.deps.findOrCreateTask(key, fill(step.newTaskTitle).trim() || key)
						live.outputs[step.id] = ticket
						runStep.status = "done"
						break
					}
					case "thread": {
						const outcome = await this.runThread(live, step, step, runStep.threads[0], fill, useTaskWorktree)
						if (outcome.kind !== "done") return this.finishStep(live, runStep, outcome)
						live.outputs[step.id] = outcome.reply
						runStep.status = "done"
						break
					}
					case "together": {
						const outcomes = await Promise.all(
							step.threads.map((thread, i) =>
								this.runThread(live, step, thread, runStep.threads[i], fill, useTaskWorktree),
							),
						)
						const bad = outcomes.find((outcome) => outcome.kind !== "done")
						if (bad) return this.finishStep(live, runStep, bad)
						step.threads.forEach((thread, i) => {
							const outcome = outcomes[i]
							if (outcome.kind === "done") live.outputs[thread.id] = outcome.reply
						})
						live.outputs[step.id] = step.threads
							.map((thread) => `### ${fill(thread.title) || thread.id}\n\n${live.outputs[thread.id] ?? ""}`)
							.join("\n\n")
						runStep.status = "done"
						break
					}
					case "checkpoint": {
						const source = step.choicesFrom
							? (definition.steps.find((candidate) => candidate.id === step.choicesFrom) as
									| AutomationTogetherStep
									| undefined)
							: undefined
						const choices = source
							? source.threads.map((thread) => fill(thread.title) || thread.id)
							: step.choices.length
								? step.choices
								: ["Continue"]
						runStep.question = fill(step.question)
						runStep.choices = choices
						runStep.status = "waiting"
						this.syncStatus(live)
						this.changed()
						const choice = await new Promise<string>((resolve) => live.answers.set(step.id, resolve))
						live.answers.delete(step.id)
						if (live.stopped) break
						runStep.choice = choice
						const picked = source?.threads[choices.indexOf(choice)]
						live.outputs[step.id] = picked ? (live.outputs[picked.id] ?? "") : choice
						runStep.status = "done"
						this.syncStatus(live)
						break
					}
					case "each": {
						const outcome = await this.runEach(live, definition, step, runStep, args, fill)
						if (outcome === "stopped") break
						if (outcome === "failed") {
							runStep.status = "failed"
							run.status = "failed"
							run.endedAt = this.now()
							return
						}
						runStep.status = "done"
						break
					}
				}
				this.changed()
			}
			if (!live.stopped) {
				run.status = "done"
				run.endedAt = this.now()
			}
		} catch (error) {
			if (live.stopped) return
			run.status = "failed"
			const message = error instanceof Error ? error.message : String(error)
			const fix =
				error instanceof AutomationCheckError
					? error.problems[0]?.fix
					: error instanceof AutomationFixableError
						? error.fix
						: undefined
			run.endedAt = this.now()
			const failed = run.steps.find((step) => step.status === "running")
			// The step that failed says why; the run only carries what belongs to no step.
			if (failed) {
				failed.status = "failed"
				failed.error = message
				failed.fix = fix
			} else {
				run.error = message
				run.fix = fix
			}
		} finally {
			if (run.status !== "running" && run.status !== "waiting") this.skipRest(run)
			// Record the final state while the run is still live, then let it go.
			this.changed()
			this.live.delete(run.id)
		}
	}

	/**
	 * For each: one run per item, each in the item's task, running the steps after this one, `atOnce` at a
	 * time. An item that fails doesn't stop the others; the step fails once they've all ended, and a retry
	 * goes on with only the items that didn't finish.
	 */
	private async runEach(
		live: LiveRun,
		definition: AutomationDefinition,
		step: AutomationEachStep,
		runStep: AutomationRunStep,
		args: Record<string, string>,
		fill: (text: string) => string,
	): Promise<"done" | "failed" | "stopped"> {
		const items = splitEachItems(fill(step.items))
		if (!items.length)
			throw new Error(`The list to go through is empty (${step.items.trim() || "no items"}). Fill it in and retry.`)
		if (items.length > MAX_EACH_ITEMS)
			throw new Error(`That's ${items.length} items; a run goes through at most ${MAX_EACH_ITEMS}. Shorten the list.`)
		const body = definition.steps.slice(definition.steps.indexOf(step) + 1)
		const kept = runStep.items ?? []
		runStep.items = items.map(
			(item): AutomationRunItem =>
				kept.find((candidate) => candidate.item === item) ?? { item, label: eachItemLabel(item), status: "pending" },
		)
		runStep.error = undefined
		this.changed()
		const queue = runStep.items.filter(
			(entry) => entry.status !== "done" || !entry.runId || this.runById(entry.runId)?.status !== "done",
		)
		const claimedTasks = new Set([live.run.taskGroupId, ...kept.flatMap((item) => item.taskGroupId ?? [])])
		for (const entry of queue) if (entry.status !== "pending") entry.status = "pending"
		const atOnce = Math.min(MAX_EACH_AT_ONCE, Math.max(1, Math.floor(step.atOnce) || DEFAULT_EACH_AT_ONCE))
		const work = async () => {
			for (let entry = queue.shift(); entry; entry = queue.shift()) {
				if (live.stopped) {
					entry.status = "skipped"
					continue
				}
				await this.runItem(live, definition, step, body, entry, items, args, claimedTasks)
			}
		}
		await Promise.all(Array.from({ length: Math.min(atOnce, queue.length) }, work))
		this.changed()
		if (live.stopped) return "stopped"
		const unfinished = runStep.items.filter((entry) => entry.status !== "done")
		if (unfinished.length) {
			runStep.error = `${unfinished.length} of ${items.length} items didn't finish. Retry goes on with only ${
				unfinished.length === 1 ? "that one" : "those"
			}.`
			return "failed"
		}
		live.outputs[step.id] = items.join("\n")
		return "done"
	}

	/** One item: a run of the steps after For each in the item's task, or the item's earlier run going on. */
	private async runItem(
		live: LiveRun,
		definition: AutomationDefinition,
		step: AutomationEachStep,
		body: readonly AutomationStep[],
		entry: AutomationRunItem,
		items: readonly string[],
		args: Record<string, string>,
		claimedTasks: Set<string>,
	): Promise<void> {
		const { run } = live
		entry.status = "running"
		entry.error = undefined
		this.changed()
		try {
			const prior = entry.runId ? this.runs.find((candidate) => candidate.id === entry.runId) : undefined
			let item: { live: LiveRun; steps: readonly AutomationStep[]; args: Record<string, string>; fromIndex: number }
			if (prior && !this.live.has(prior.id) && (prior.status === "failed" || prior.status === "stopped")) {
				// Retry: the item's run goes on from its step that didn't finish.
				item = this.prepareResume(prior, definition)
				item.live.run.costLimit = undefined
				item.live.outputs = { ...live.outputs, ...item.live.outputs }
			} else {
				const itemArgs = { ...args, [ITEM_PLACEHOLDER]: entry.item }
				const fillItem = (text: string) => fillPlaceholders(text, { args: itemArgs, outputs: live.outputs })
				const ticket = fillItem(step.ticket).trim()
				const key = ticket ? ticketKey(ticket) : undefined
				const title = fillItem(step.newTaskTitle).trim() || key || entry.label
				let taskGroupId = key ? await this.deps.findOrCreateTask(key, title) : await this.deps.createTask(title)
				// Distinct items may resolve to the same ticket. Each gets its own task.
				if (claimedTasks.has(taskGroupId)) taskGroupId = await this.deps.createTask(title, key)
				claimedTasks.add(taskGroupId)
				if (live.stopped) {
					entry.status = "skipped"
					return
				}
				const parent = {
					runId: run.id,
					stepId: step.id,
					item: entry.item,
					index: items.indexOf(entry.item),
					total: items.length,
				}
				const itemRun: AutomationRun = {
					id: this.newId(),
					automation: run.automation,
					title: run.title,
					values: run.values,
					taskGroupId,
					status: "running",
					steps: body.map(runStepFor),
					startedAt: this.now(),
					...(run.context ? { context: run.context } : {}),
					parent,
				}
				item = {
					live: {
						run: itemRun,
						stopped: false,
						outputs: { ...live.outputs },
						answers: new Map(),
						costBase: 0,
						keepNotes: live.keepNotes,
						context: live.context,
					},
					steps: body,
					args: itemArgs,
					fromIndex: 0,
				}
				const context = this.contexts.get(run.id)
				if (context) this.contexts.set(itemRun.id, context)
				this.runs = [...this.runs, structuredClone(itemRun)]
			}
			entry.runId = item.live.run.id
			entry.taskGroupId = item.live.run.taskGroupId
			this.live.set(entry.runId, item.live)
			this.changed()
			await this.execute(item.live, definition, item.steps, item.args, item.fromIndex, true)
			const ended = this.runById(entry.runId)
			if (ended) entry.status = itemStatus(ended.status)
		} catch (error) {
			entry.status = "failed"
			entry.error = error instanceof Error ? error.message : String(error)
		}
		this.changed()
	}

	private finishStep(live: LiveRun, runStep: AutomationRunStep, outcome: ThreadOutcome): void {
		const { run } = live
		if (outcome.kind === "failed") {
			// The thread row says why (it's the thread's problem); the step only marks where it stopped.
			runStep.status = "failed"
			runStep.fix = outcome.fix
			run.status = "failed"
		} else {
			runStep.status = "stopped"
			if (run.status !== "stopped") {
				run.status = "stopped"
				run.error = live.stopped ? undefined : "A thread was stopped from its own page."
			}
		}
		run.endedAt = this.now()
	}

	/** Waiting when any thread or Ask you step needs the user; running otherwise. */
	private syncStatus(live: LiveRun): void {
		if (!isLiveRun(live.run)) return
		const waiting = live.run.steps.some(
			(step) =>
				step.status === "waiting" ||
				step.threads.some((thread) => thread.status === "waiting") ||
				!!step.items?.some((item) => item.status === "waiting"),
		)
		live.run.status = waiting ? "waiting" : "running"
	}

	/** Dollars the run's threads have spent in all. */
	private spent(run: AutomationRun): number {
		let total = 0
		for (const step of run.steps) {
			for (const item of step.items ?? []) {
				const child = item.runId ? this.runById(item.runId) : undefined
				if (child) total += this.spent(child)
			}
			for (const thread of step.threads) {
				if (!thread.threadId) continue
				const cost = this.deps.threadCost?.(thread.threadId)
				if (cost !== undefined) this.costs.set(thread.threadId, cost)
				total += this.costs.get(thread.threadId) ?? 0
			}
		}
		return total
	}

	/** Stops runs that went past their cost limit. Polls only while such a run is going. */
	private watchCosts(): void {
		if (this.costTimer || !this.deps.threadCost) return
		this.costTimer = setInterval(() => {
			const limited = [...this.live.values()].filter((live) => live.run.costLimit && !live.stopped)
			if (!limited.length) {
				clearInterval(this.costTimer)
				this.costTimer = undefined
				return
			}
			for (const live of limited) this.checkCost(live)
		}, COST_POLL_MS)
		;(this.costTimer as { unref?: () => void }).unref?.()
	}

	private checkCost(itemOrRun: LiveRun): void {
		// An item's run counts toward the limit of the run it belongs to.
		const parentId = itemOrRun.run.parent?.runId
		const live = (parentId && this.live.get(parentId)) || itemOrRun
		const limit = live.run.costLimit
		if (!limit || live.stopped) return
		const spent = this.spent(live.run) - live.costBase
		if (spent < limit) return
		void this.stop(live.run.id, {
			error: costStopMessage(limit, formatAutomationCost(spent)),
		})
	}

	private skipRest(run: AutomationRun): void {
		for (const step of run.steps) {
			if (step.status === "pending") step.status = "skipped"
			for (const item of step.items ?? []) if (item.status === "pending") item.status = "skipped"
			for (const thread of step.threads) if (thread.status === "pending") thread.status = "skipped"
		}
	}

	private async runThread(
		live: LiveRun,
		step: AutomationThreadStep | AutomationTogetherStep,
		spec: AutomationThreadSpec,
		runThread: AutomationRunThread,
		fill: (text: string) => string,
		useTaskWorktree: boolean,
	): Promise<ThreadOutcome> {
		if (live.stopped) return { kind: "stopped" }
		// Kept from before a retry: it already replied.
		if (runThread.status === "done" && live.outputs[spec.id] !== undefined)
			return { kind: "done", reply: live.outputs[spec.id] }
		runThread.title = fill(spec.title) || spec.id
		runThread.status = "running"
		const scope = automationWorkspace(spec) ?? (useTaskWorktree ? "task" : undefined)
		runThread.worktreeScope = scope
		runThread.worktree = scope === "task" || scope === "thread"
		const template = threadPrompt(step, spec)
		const { context } = live
		// The user's context goes where the automation puts {{context}}, else after every thread's prompt.
		const getsContext = context.placed
			? placeholderRefs(template).some((ref) => ref.kind === "arg" && ref.name === CONTEXT_PLACEHOLDER)
			: !!context.text || context.images.length > 0 || context.files.length > 0
		const prompt = fill(template)
		let threadId: string
		try {
			threadId = await this.deps.startThread({
				runId: live.run.id,
				taskGroupId: live.run.taskGroupId,
				title: runThread.title,
				prompt: context.placed ? prompt : withContextBlock(prompt, context.text),
				model: spec.model,
				level: spec.level,
				mode: spec.mode,
				worktree: runThread.worktree,
				...(scope ? { worktreeScope: scope } : {}),
				...(getsContext && context.images.length ? { images: [...context.images] } : {}),
				...(getsContext && context.files.length ? { files: [...context.files] } : {}),
				...(spec.outputs?.length || live.keepNotes
					? {
							onSessionId: (id: string) => {
								runThread.threadId = id
							},
						}
					: {}),
			})
		} catch (error) {
			runThread.status = "failed"
			runThread.error = error instanceof Error ? error.message : String(error)
			runThread.fix = error instanceof AutomationFixableError ? error.fix : undefined
			this.changed()
			return { kind: "failed", error: runThread.error, fix: runThread.fix }
		}
		runThread.threadId = threadId
		this.changed()
		const outcome = live.stopped
			? ({ kind: "stopped" } as const)
			: await new Promise<ThreadOutcome>((resolve) => {
					this.waiting.set(threadId, { runId: live.run.id, resolve })
					// The first turn may finish before startup returns. Subscribe
					// before reading back its state so neither an early nor a later outcome is lost.
					const state = this.deps.readThreadState?.(threadId)
					if (state)
						this.threadStatusChanged(
							threadId,
							state.status,
							() => state.messages,
							() => state.cancelled,
						)
				})
		this.waiting.delete(threadId)
		runThread.waitingOn = undefined
		runThread.missingOutputs = undefined
		if (outcome.kind === "done") {
			try {
				for (const output of spec.outputs ?? []) {
					const recorded = runThread.outputs?.find(({ name }) => name === output.name)
					if (recorded && output.saveAsNote && this.deps.saveOutputNote)
						recorded.noteSlug = await this.deps.saveOutputNote(
							live.run.taskGroupId,
							{ threadId, title: runThread.title },
							output,
							live.outputs[`${spec.id}.${output.name}`],
						)
					if (live.stopped) return { kind: "stopped" }
				}
			} catch (error) {
				runThread.status = "failed"
				runThread.error = `Couldn't save an output as a note. ${error instanceof Error ? error.message : String(error)}`
				this.changed()
				return { kind: "failed", error: runThread.error }
			}
			runThread.status = "done"
			runThread.reply = trimReply(outcome.reply)
			live.outputs[spec.id] = outcome.reply
			void this.deps.nameThread?.(threadId, runThread.title).catch(() => {})
		} else if (outcome.kind === "failed") {
			runThread.status = "failed"
			runThread.error = outcome.error
		} else runThread.status = "stopped"
		this.syncStatus(live)
		this.changed()
		return outcome
	}

	private threadOf(threadId: string): { live: LiveRun; thread: AutomationRunThread } | undefined {
		for (const live of this.live.values()) {
			for (const step of live.run.steps) {
				const thread = step.threads.find((candidate) => candidate.threadId === threadId)
				if (thread) return { live, thread }
			}
		}
		return undefined
	}

	outputsForThread(threadId: string) {
		const found = this.threadOf(threadId)
		if (!found) return undefined
		const { live, thread } = found
		const outputs = thread.declaredOutputs
		if (!outputs?.length) return undefined
		const active = () =>
			!live.stopped && (thread.status === "running" || thread.status === "waiting") && this.live.get(live.run.id) === live
		if (!active()) return undefined
		return {
			outputs,
			active,
			missing: () => outputs.filter(({ name }) => live.outputs[`${thread.id}.${name}`] === undefined),
			record: (name: string, value: string) => {
				if (!active() || thread.status !== "running")
					throw new Error("This automation step is no longer recording outputs.")
				if (!outputs.some((output) => output.name === name)) throw new Error(`"${name}" is not declared by this step.`)
				live.outputs[`${thread.id}.${name}`] = value
				thread.outputs = [
					...(thread.outputs ?? []).filter((output) => output.name !== name),
					{ name, firstLine: trimReply(value.trimStart().split(/\r?\n/, 1)[0]) },
				]
				this.changed()
			},
		}
	}

	async answerMissingOutputs(runId: string, threadId: string, askAgain: boolean): Promise<void> {
		const found = this.threadOf(threadId)
		const waiter = this.waiting.get(threadId)
		const missing = found?.thread.missingOutputs
		if (
			!found ||
			found.live.stopped ||
			waiter?.runId !== runId ||
			waiter.reply === undefined ||
			!missing?.length ||
			waiter.askingAgain
		)
			throw new Error("That step is no longer waiting for outputs.")
		if (!askAgain) {
			found.thread.missingOutputs = undefined
			waiter.resolve({ kind: "done", reply: waiter.reply })
			return
		}
		if (!this.deps.askForOutputs) throw new Error("Open the thread and ask it for the missing outputs.")
		waiter.askingAgain = true
		try {
			await this.deps.askForOutputs(threadId, missing)
		} finally {
			waiter.askingAgain = false
		}
	}

	/**
	 * A thread's session status changed. `messages` is read only when its turn ended, to tell a finished
	 * reply from a question for the user. A turn the user cancelled in the thread isn't a reply either,
	 * and neither is an error: the step waits until they retry or resume it in the thread (or stop the
	 * run and retry the step from the run). Threads no run is waiting on are ignored.
	 */
	threadStatusChanged(
		threadId: string,
		status: "running" | "waiting" | "done" | "error" | "stopped",
		readMessages: () => readonly ClineMessage[],
		wasCancelled: () => boolean = () => false,
	): void {
		const found = this.threadOf(threadId)
		const waiter = this.waiting.get(threadId)
		if (!found || !waiter) return
		const { live, thread } = found
		const set = (next: AutomationRunThread["status"], waitingOn?: string) => {
			if (thread.status === next && thread.waitingOn === waitingOn) return
			thread.status = next
			thread.waitingOn = next === "waiting" ? waitingOn : undefined
			this.syncStatus(live)
			this.changed()
		}
		this.checkCost(live)
		if (live.stopped) return
		if (status === "running") {
			thread.missingOutputs = undefined
			set("running")
		} else if (status === "waiting") {
			set("waiting", this.deps.describeWaiting?.(threadId) ?? "Needs your answer in the thread")
		} else if (status === "error") {
			set("waiting", "Hit an error: open it and press Retry")
		} else if (status === "stopped") {
			waiter.resolve({ kind: "stopped" })
		} else if (wasCancelled()) {
			set("waiting", "You stopped its turn: send a message there to go on")
		} else {
			const end = classifyTurnEnd(readMessages())
			if (end.kind === "waiting") set("waiting", this.deps.describeWaiting?.(threadId) ?? "Answer its question")
			else {
				const missing = thread.declaredOutputs
					?.filter(({ name }) => live.outputs[`${thread.id}.${name}`] === undefined)
					.map(({ name }) => name)
				if (missing?.length) {
					waiter.reply = end.reply
					thread.missingOutputs = missing
					set("waiting", `Missing outputs: ${missing.join(", ")}`)
				} else waiter.resolve({ kind: "done", reply: end.reply })
			}
		}
	}

	/** The user's pick at a checkpoint. */
	answer(runId: string, stepId: string, choice: string): void {
		const live = this.live.get(runId)
		const step = live?.run.steps.find((candidate) => candidate.id === stepId)
		const resolve = live?.answers.get(stepId)
		if (!live || !step || !resolve) throw new Error("That run isn't waiting for this answer anymore.")
		if (!step.choices?.includes(choice)) throw new Error(`Pick one of: ${step.choices?.join(", ")}`)
		resolve(choice)
	}

	/** Stops a run: running threads are stopped, the rest is skipped. Everything done so far stays. */
	async stop(runId: string, options: { error?: string } = {}): Promise<void> {
		const live = this.live.get(runId)
		if (!live || live.stopped) return
		live.stopped = true
		live.run.status = "stopped"
		live.run.error = options.error
		live.run.endedAt = this.now()
		const running: string[] = []
		for (const step of live.run.steps) {
			if (step.status === "running" || step.status === "waiting") step.status = "stopped"
			for (const thread of step.threads) {
				if (thread.threadId && (thread.status === "running" || thread.status === "waiting")) running.push(thread.threadId)
				if (thread.status === "running" || thread.status === "waiting") {
					thread.status = "stopped"
					thread.waitingOn = undefined
					thread.missingOutputs = undefined
				}
			}
		}
		for (const answer of live.answers.values()) answer("")
		for (const [threadId, waiter] of this.waiting) if (waiter.runId === runId) waiter.resolve({ kind: "stopped" })
		this.changed()
		const items = [...this.live.values()].filter((candidate) => candidate.run.parent?.runId === runId)
		await Promise.all([
			...running.map((id) => this.deps.stopThread(id).catch(() => {})),
			...items.map((item) => this.stop(item.run.id)),
		])
	}
}
