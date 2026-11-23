import { resolveAutomationModel } from "@shared/automation-models"
import {
	type AutomationDefinition,
	type AutomationRun,
	type AutomationThreadSpec,
	automationTaskWorktrees,
	automationWorkspace,
	fillPlaceholders,
	formatAutomationCost,
	runThreadIds,
	withArgumentDefaults,
} from "@shared/automations"
import type { HistoryItem } from "@shared/HistoryItem"
import type { ModelSettingsState } from "@shared/model-settings-state"

export interface WillRunThread {
	title: string
	/** "Opus 5.5 · High", or "Default (Sonnet 5.5)" for a step that names no model. */
	model: string
	mode: "Ask" | "Act"
	worktree: boolean
	worktreeScope?: "task" | "thread"
	/** Why it can't start as written; links to Settings › Models. */
	problem?: string
}

export interface WillRunStep {
	number: number
	kind: AutomationDefinition["steps"][number]["kind"]
	title: string
	/** One line under the title for steps without threads. */
	detail?: string
	threads: WillRunThread[]
}

export interface WillRun {
	steps: WillRunStep[]
	threadCount: number
	models: string[]
	worktrees: number
	pauses: number
	/** Steps that can't run as written; Run stays off until they're fixed. */
	problems: string[]
	/** "Cost depends on…" or a range from earlier runs. */
	cost: string
}

/** Every step with what it will start, so nothing runs before the user has seen its models. */
export function describeRun(
	definition: AutomationDefinition,
	values: Readonly<Record<string, string>>,
	modelSettings: ModelSettingsState | undefined,
	context: { inTask: boolean; earlierRuns?: readonly AutomationRun[]; history?: readonly HistoryItem[] },
): WillRun {
	const args = withArgumentDefaults(definition.arguments, values)
	// Earlier steps' replies aren't known yet: show where they'll go.
	const fill = (text: string) =>
		fillPlaceholders(text, {
			args: Object.fromEntries(Object.entries(args).map(([key, value]) => [key, value || `{${key}}`])),
			outputs: new Proxy({}, { get: (_target, key) => `{${String(key)}}` }) as Record<string, string>,
		})
	const problems: string[] = []
	const models = new Set<string>()
	const prices = new Map<string, string>()
	const describeThread = (spec: AutomationThreadSpec, sharesWorktree: boolean): WillRunThread => {
		const choice = automationWorkspace(spec) ?? (sharesWorktree ? "task" : undefined)
		const worktreeScope = choice === "task" || choice === "thread" ? choice : undefined
		const thread: WillRunThread = {
			title: fill(spec.title) || spec.id,
			model: spec.model || "Default",
			mode: spec.mode === "act" ? "Act" : "Ask",
			worktree: !!worktreeScope,
			worktreeScope,
		}
		if (!modelSettings) {
			thread.model = spec.model ? `${spec.model}${spec.level ? ` · ${spec.level}` : ""}` : "Your current model"
			models.add(thread.model)
			return thread
		}
		const resolved = resolveAutomationModel(modelSettings, spec.model, spec.level, spec.mode)
		if (!resolved.ok) {
			thread.problem = resolved.reason
			problems.push(`${thread.title}: ${resolved.reason}`)
			return thread
		}
		const named = `${resolved.label}${resolved.levelLabel ? ` · ${resolved.levelLabel}` : ""}`
		thread.model = resolved.isDefault ? `Default (${named})` : named
		models.add(resolved.label)
		if (resolved.inputPrice !== null && resolved.outputPrice !== null)
			prices.set(
				resolved.label,
				`${resolved.label} ${formatAutomationCost(resolved.inputPrice)} in / ${formatAutomationCost(resolved.outputPrice)} out`,
			)
		return thread
	}

	let threadCount = 0
	const { count, threadSteps } = automationTaskWorktrees(definition.steps)
	let worktrees = count
	let pauses = 0
	const steps = definition.steps.map((step, index): WillRunStep => {
		const base = { number: index + 1, kind: step.kind, title: fill(step.title) || step.id }
		switch (step.kind) {
			case "task": {
				const ticket = fill(step.ticket)
				return { ...base, detail: `Finds the task tagged ${ticket}, or makes one`, threads: [] }
			}
			case "thread":
			case "together": {
				const specs = step.kind === "thread" ? [step] : step.threads
				const threads = specs.map((spec) => describeThread(spec, threadSteps.has(step.id)))
				threadCount += threads.length
				worktrees += threads.filter((thread) => thread.worktreeScope === "thread").length
				return { ...base, detail: step.kind === "together" ? `${threads.length} threads at once` : undefined, threads }
			}
			case "checkpoint": {
				pauses++
				const from = step.choicesFrom
					? definition.steps.find((candidate) => candidate.id === step.choicesFrom)
					: undefined
				const choices = from?.kind === "together" ? from.threads.map((t) => fill(t.title) || t.id) : step.choices
				return {
					...base,
					detail: choices.length ? `Waits for you to pick: ${choices.join(", ")}` : "Waits for you to continue",
					threads: [],
				}
			}
		}
	})
	if (!context.inTask && definition.steps[0]?.kind !== "task") {
		steps.unshift({ number: 0, kind: "task", title: "New task", detail: "Makes a task for this run", threads: [] })
	}

	// Earlier runs of this automation say what it really costs; prices alone can't.
	const costs = (context.earlierRuns ?? [])
		.filter((run) => run.automation === definition.name && run.status === "done")
		.slice(-3)
		.map((run) =>
			runThreadIds(run).reduce((sum, id) => sum + (context.history?.find((item) => item.id === id)?.totalCost ?? 0), 0),
		)
		.filter((cost) => cost > 0)
	let cost: string
	if (costs.length) {
		const low = Math.min(...costs)
		const high = Math.max(...costs)
		const label = costs.length === 1 ? "Last run" : `Last ${costs.length} runs`
		cost = `${label} ${low === high ? formatAutomationCost(low) : `${formatAutomationCost(low)}–${formatAutomationCost(high)}`}`
	} else if (threadCount === 0) {
		cost = "No model calls"
	} else {
		cost = `Cost depends on how much each thread reads and writes.${
			prices.size ? ` Per million tokens: ${[...prices.values()].join("; ")}.` : ""
		}`
	}
	return { steps, threadCount, models: [...models], worktrees, pauses, problems, cost }
}

/** "4 threads on 3 models · 1 worktree · pauses once". */
export function summarizeRun(willRun: WillRun): string {
	const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`
	const parts = [
		willRun.threadCount
			? `${plural(willRun.threadCount, "thread")}${willRun.models.length ? ` on ${plural(willRun.models.length, "model")}` : ""}`
			: "",
		willRun.worktrees ? plural(willRun.worktrees, "worktree") : "",
		willRun.pauses ? (willRun.pauses === 1 ? "pauses once" : `pauses ${willRun.pauses} times`) : "",
	]
	return parts.filter(Boolean).join(" · ")
}

/** Steps whose model can't run as written: Run stays off until they're fixed. */
export function runProblems(definition: AutomationDefinition, modelSettings: ModelSettingsState | undefined): string[] {
	return describeRun(definition, {}, modelSettings, { inTask: true }).problems
}
