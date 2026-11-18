import {
	type AutomationDefinition,
	type AutomationRun,
	type AutomationRunStep,
	type AutomationRunThread,
	type AutomationStep,
	type AutomationThreadSpec,
	type AutomationThreadStep,
	type AutomationTogetherStep,
	automationDisplayName,
	fillPlaceholders,
	isLiveRun,
	threadPrompt,
	withArgumentDefaults,
} from "@shared/automations"
import type { ClineMessage } from "@shared/ExtensionMessage"

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
	onChange: (runs: readonly AutomationRun[]) => void
	load?: () => Promise<AutomationRun[]>
	save?: (runs: readonly AutomationRun[]) => Promise<void>
	now?: () => number
	newId?: () => string
}

type ThreadOutcome = { kind: "done"; reply: string } | { kind: "failed"; error: string } | { kind: "stopped" }

interface LiveRun {
	run: AutomationRun
	stopped: boolean
	/** Full replies by step or thread id (the wire copy is trimmed). */
	outputs: Record<string, string>
	/** Checkpoint answers waiting by step id. */
	answers: Map<string, (choice: string) => void>
}

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
		status: "pending",
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
	private runs: AutomationRun[] = []
	private readonly waiting = new Map<string, { runId: string; resolve: (outcome: ThreadOutcome) => void }>()
	private loaded: Promise<void> | undefined

	constructor(private readonly deps: AutomationRunnerDeps) {}

	private now(): number {
		return this.deps.now?.() ?? Date.now()
	}

	private newId(): string {
		return this.deps.newId?.() ?? `run-${this.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
	}

	/** Earlier runs from disk. A run that was going when VS Code closed can't pick up again: it shows as stopped. */
	load(): Promise<void> {
		this.loaded ??= (async () => {
			const stored = (await this.deps.load?.().catch(() => [])) ?? []
			const known = new Set(this.runs.map((run) => run.id))
			const restored = stored
				.filter((run) => !known.has(run.id))
				.map((run) =>
					isLiveRun(run)
						? {
								...run,
								status: "stopped" as const,
								endedAt: run.endedAt ?? this.now(),
								error: "VS Code closed while it ran. Its threads are kept.",
								steps: run.steps.map((step) =>
									step.status === "running" || step.status === "waiting" || step.status === "pending"
										? {
												...step,
												status: step.status === "pending" ? ("skipped" as const) : ("stopped" as const),
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

	private changed(): void {
		this.runs = this.runs.map((run) => {
			const live = this.live.get(run.id)
			return live ? structuredClone(live.run) : run
		})
		this.deps.onChange(this.runs)
		void this.deps.save?.(this.runs.slice(-KEPT_RUNS)).catch(() => {})
	}

	/**
	 * Starts a run. `taskGroupId` is the task the user started it in; without one (and without an
	 * Open a task step) the run makes a task named after the automation.
	 */
	async start(
		definition: AutomationDefinition,
		values: Readonly<Record<string, string>>,
		options: { taskGroupId?: string } = {},
	): Promise<AutomationRun> {
		await this.load()
		const args = withArgumentDefaults(definition.arguments, values)
		const missing = definition.arguments.filter((arg) => arg.required && !args[arg.name])
		if (missing.length) throw new Error(`Needs ${missing.map((arg) => arg.name).join(", ")}`)
		const run: AutomationRun = {
			id: this.newId(),
			automation: definition.name,
			title: automationDisplayName(definition),
			values: args,
			taskGroupId: options.taskGroupId ?? "",
			status: "running",
			steps: definition.steps.map(runStepFor),
			startedAt: this.now(),
		}
		// The first step that needs a task decides it: an Open a task step, or a task made now.
		if (!run.taskGroupId && definition.steps[0]?.kind !== "task") {
			const ticketArg = definition.arguments.find((arg) => arg.kind === "ticket" && args[arg.name])
			const ticket = ticketArg ? args[ticketArg.name] : undefined
			run.taskGroupId = await this.deps.createTask(ticket ? `${run.title} · ${ticket}` : run.title, ticket)
		}
		const live: LiveRun = { run, stopped: false, outputs: {}, answers: new Map() }
		this.live.set(run.id, live)
		this.runs = [...this.runs, structuredClone(run)]
		this.changed()
		void this.execute(live, definition, args)
		return structuredClone(run)
	}

	private async execute(live: LiveRun, definition: AutomationDefinition, args: Record<string, string>): Promise<void> {
		const { run } = live
		const fill = (text: string) => fillPlaceholders(text, { args, outputs: live.outputs })
		try {
			for (const [index, step] of definition.steps.entries()) {
				if (live.stopped) break
				const runStep = run.steps[index]
				runStep.title = fill(step.title) || step.id
				runStep.status = "running"
				this.changed()
				switch (step.kind) {
					case "task": {
						const ticket = fill(step.ticket).trim()
						if (!ticket) throw new Error("No ticket to find the task by. Fill in the ticket and run it again.")
						run.taskGroupId = await this.deps.findOrCreateTask(ticket, fill(step.newTaskTitle).trim() || ticket)
						live.outputs[step.id] = ticket
						runStep.status = "done"
						break
					}
					case "thread": {
						const outcome = await this.runThread(live, step, step, runStep.threads[0], fill)
						if (outcome.kind !== "done") return this.finishStep(live, runStep, outcome)
						live.outputs[step.id] = outcome.reply
						runStep.status = "done"
						break
					}
					case "together": {
						const outcomes = await Promise.all(
							step.threads.map((thread, i) => this.runThread(live, step, thread, runStep.threads[i], fill)),
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
						run.status = "waiting"
						this.changed()
						const choice = await new Promise<string>((resolve) => live.answers.set(step.id, resolve))
						live.answers.delete(step.id)
						if (live.stopped) break
						runStep.choice = choice
						const picked = source?.threads[choices.indexOf(choice)]
						live.outputs[step.id] = picked ? (live.outputs[picked.id] ?? "") : choice
						runStep.status = "done"
						run.status = "running"
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
			run.status = "failed"
			run.error = error instanceof Error ? error.message : String(error)
			run.endedAt = this.now()
			for (const step of run.steps) if (step.status === "running") step.status = "failed"
		} finally {
			if (run.status !== "running" && run.status !== "waiting") this.skipRest(run)
			// Record the final state while the run is still live, then let it go.
			this.changed()
			this.live.delete(run.id)
		}
	}

	private finishStep(live: LiveRun, runStep: AutomationRunStep, outcome: ThreadOutcome): void {
		const { run } = live
		if (outcome.kind === "failed") {
			runStep.status = "failed"
			runStep.error = outcome.error
			run.status = "failed"
			run.error = `${runStep.title}: ${outcome.error}`
		} else {
			runStep.status = "stopped"
			if (run.status !== "stopped") {
				run.status = "stopped"
				run.error = live.stopped ? undefined : `${runStep.title} was stopped`
			}
		}
		run.endedAt = this.now()
	}

	private skipRest(run: AutomationRun): void {
		for (const step of run.steps) {
			if (step.status === "pending") step.status = "skipped"
			for (const thread of step.threads) if (thread.status === "pending") thread.status = "skipped"
		}
	}

	private async runThread(
		live: LiveRun,
		step: AutomationThreadStep | AutomationTogetherStep,
		spec: AutomationThreadSpec,
		runThread: AutomationRunThread,
		fill: (text: string) => string,
	): Promise<ThreadOutcome> {
		if (live.stopped) return { kind: "stopped" }
		runThread.title = fill(spec.title) || spec.id
		runThread.status = "running"
		let threadId: string
		try {
			threadId = await this.deps.startThread({
				runId: live.run.id,
				taskGroupId: live.run.taskGroupId,
				title: runThread.title,
				prompt: fill(threadPrompt(step, spec)),
				model: spec.model,
				level: spec.level,
				mode: spec.mode,
				worktree: spec.worktree,
			})
		} catch (error) {
			runThread.status = "failed"
			runThread.error = error instanceof Error ? error.message : String(error)
			this.changed()
			return { kind: "failed", error: runThread.error }
		}
		runThread.threadId = threadId
		this.changed()
		const outcome = live.stopped
			? ({ kind: "stopped" } as const)
			: await new Promise<ThreadOutcome>((resolve) => {
					this.waiting.set(threadId, { runId: live.run.id, resolve })
					// Startup can still be saving a title after the first turn has finished. Subscribe
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
		if (outcome.kind === "done") {
			runThread.status = "done"
			runThread.reply = trimReply(outcome.reply)
		} else if (outcome.kind === "failed") {
			runThread.status = "failed"
			runThread.error = outcome.error
		} else runThread.status = "stopped"
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

	/**
	 * A thread's session status changed. `messages` is read only when its turn ended, to tell a finished
	 * reply from a question for the user. A turn the user cancelled in the thread isn't a reply either:
	 * the step waits until they resume it. Threads no run is waiting on are ignored.
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
		const { thread } = found
		const set = (next: AutomationRunThread["status"]) => {
			if (thread.status === next) return
			thread.status = next
			this.changed()
		}
		if (status === "running" || status === "waiting") {
			set(status)
		} else if (status === "error") {
			waiter.resolve({ kind: "failed", error: "The thread hit an error. Open it to see why, then retry there." })
		} else if (status === "stopped") {
			waiter.resolve({ kind: "stopped" })
		} else if (wasCancelled()) {
			set("waiting")
		} else {
			const end = classifyTurnEnd(readMessages())
			if (end.kind === "waiting") set("waiting")
			else waiter.resolve({ kind: "done", reply: end.reply })
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
	async stop(runId: string): Promise<void> {
		const live = this.live.get(runId)
		if (!live) return
		live.stopped = true
		live.run.status = "stopped"
		live.run.endedAt = this.now()
		const running: string[] = []
		for (const step of live.run.steps) {
			if (step.status === "running" || step.status === "waiting") step.status = "stopped"
			for (const thread of step.threads) {
				if (thread.threadId && (thread.status === "running" || thread.status === "waiting")) running.push(thread.threadId)
			}
		}
		for (const answer of live.answers.values()) answer("")
		for (const [threadId, waiter] of this.waiting) if (waiter.runId === runId) waiter.resolve({ kind: "stopped" })
		this.changed()
		await Promise.all(running.map((id) => this.deps.stopThread(id).catch(() => {})))
	}
}
