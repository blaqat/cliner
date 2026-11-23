import { resolveAutomationModel } from "@shared/automation-models"
import {
	type AutomationDefinition,
	type AutomationRun,
	type AutomationThreadSpec,
	automationTaskWorktrees,
	automationWorkspace,
	CONTEXT_PLACEHOLDER,
	eachStepIndex,
	fillPlaceholders,
	formatAutomationCost,
	ITEM_PLACEHOLDER,
	splitEachItems,
	withArgumentDefaults,
} from "@shared/automations"
import type { HistoryItem } from "@shared/HistoryItem"
import type { ModelSettingsState } from "@shared/model-settings-state"
import type { ThreadWorkspaceChoice } from "@shared/thread-worktrees"
import { runCost } from "./runFacts"

export interface WillRunThread {
	title: string
	/** "Opus 5.5 · High", or "Default (Sonnet 5.5)" for a step that names no model. */
	model: string
	mode: "Ask" | "Act"
	worktree: boolean
	worktreeScope?: ThreadWorkspaceChoice
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
	/** Runs once per item of the For each step before it. */
	perItem?: boolean
}

interface RunCounts {
	threadCount: number
	worktrees: number
	pauses: number
}

export interface WillRun extends RunCounts {
	steps: WillRunStep[]
	models: string[]
	perItem?: RunCounts
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
	context: { inTask: boolean; text?: string; earlierRuns?: readonly AutomationRun[]; history?: readonly HistoryItem[] },
): WillRun {
	const args: Record<string, string> = withArgumentDefaults(definition.arguments, values)
	args[CONTEXT_PLACEHOLDER] = context.text?.trim() ?? ""
	args[ITEM_PLACEHOLDER] = ""
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
		const worktreeScope = automationWorkspace(spec) ?? (sharesWorktree ? "task" : undefined)
		const thread: WillRunThread = {
			title: fill(spec.title) || spec.id,
			model: spec.model || "Default",
			mode: spec.mode === "act" ? "Act" : "Ask",
			worktree: worktreeScope === "task" || worktreeScope === "thread",
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

	const each = eachStepIndex(definition.steps)
	const { count, threadSteps } = automationTaskWorktrees(definition.steps)
	const itemWorktrees = each < 0 ? 0 : automationTaskWorktrees(definition.steps.slice(each + 1)).count
	const parent: RunCounts = { threadCount: 0, worktrees: count - itemWorktrees, pauses: 0 }
	const item: RunCounts = { threadCount: 0, worktrees: itemWorktrees, pauses: 0 }
	const steps = definition.steps.map((step, index): WillRunStep => {
		const perItem = each >= 0 && index > each
		const counts = perItem ? item : parent
		const base = {
			number: index + 1,
			kind: step.kind,
			title: fill(step.title) || step.id,
			perItem,
		}
		switch (step.kind) {
			case "each": {
				const first = index + 2
				const last = definition.steps.length
				const items = fill(step.items)
				const listed = splitEachItems(items)
				const what = listed.length > 1 ? `each of ${listed.length} items` : listed[0] || "each item"
				return {
					...base,
					detail: `${first === last ? `Step ${first} runs` : `Steps ${first}–${last} run`} for ${what}. Up to ${step.atOnce} items at a time, each in its own task.`,
					threads: [],
				}
			}
			case "task": {
				const ticket = fill(step.ticket)
				return { ...base, detail: `Finds the task tagged ${ticket}, or makes one`, threads: [] }
			}
			case "thread":
			case "together": {
				const specs = step.kind === "thread" ? [step] : step.threads
				const threads = specs.map((spec) => describeThread(spec, threadSteps.has(step.id)))
				counts.threadCount += threads.length
				counts.worktrees += threads.filter((thread) => thread.worktreeScope === "thread").length
				return { ...base, detail: step.kind === "together" ? `${threads.length} threads at once` : undefined, threads }
			}
			case "checkpoint": {
				counts.pauses++
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
		.filter((run) => run.automation === definition.name && run.status === "done" && !run.parent)
		.slice(-3)
		.map((run) => runCost(run, context.history, context.earlierRuns))
		.filter((cost) => cost > 0)
	let cost: string
	if (costs.length) {
		const low = Math.min(...costs)
		const high = Math.max(...costs)
		const label = costs.length === 1 ? "Last run" : `Last ${costs.length} runs`
		cost = `${label} ${low === high ? formatAutomationCost(low) : `${formatAutomationCost(low)}–${formatAutomationCost(high)}`}`
	} else if (parent.threadCount + item.threadCount === 0) {
		cost = "No model calls"
	} else {
		cost = `Cost depends on how much each thread reads and writes.${
			prices.size ? ` Per million tokens: ${[...prices.values()].join("; ")}.` : ""
		}`
	}
	return { ...parent, steps, models: [...models], problems, cost, ...(each >= 0 ? { perItem: item } : {}) }
}

/** "4 threads on 3 models · 1 worktree · pauses once". */
export function summarizeRun(willRun: WillRun): string {
	const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`
	const work = (counts: RunCounts) =>
		[
			counts.threadCount ? plural(counts.threadCount, "thread") : "",
			counts.worktrees ? plural(counts.worktrees, "worktree") : "",
			counts.pauses ? (counts.pauses === 1 ? "pauses once" : `pauses ${counts.pauses} times`) : "",
		].filter(Boolean)
	if (willRun.perItem) {
		const perItem = work(willRun.perItem).join(", ")
		return [...work(willRun), perItem && `${perItem} per item`].filter(Boolean).join(" · ")
	}
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
