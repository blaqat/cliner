import { type AutomationRun, type AutomationRunStepStatus, isLiveRun, runThreadIds } from "@shared/automations"
import type { HistoryItem } from "@shared/HistoryItem"

/** Dollars spent by the run's threads so far (from their history rows). */
export function runCost(run: AutomationRun, history: readonly HistoryItem[] | undefined): number {
	const ids = new Set(runThreadIds(run))
	return (history ?? []).filter((item) => ids.has(item.id)).reduce((sum, item) => sum + (item.totalCost ?? 0), 0)
}

export function formatCost(dollars: number): string {
	return dollars > 0 ? `$${dollars.toFixed(2)}` : ""
}

/** "4 min", "45 s", "1 h 5 min". */
export function formatElapsed(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000))
	if (seconds < 60) return `${seconds} s`
	const minutes = Math.round(seconds / 60)
	if (minutes < 60) return `${minutes} min`
	return `${Math.floor(minutes / 60)} h ${minutes % 60} min`
}

const STATUS_WORDS: Record<AutomationRun["status"], string> = {
	running: "running",
	waiting: "waiting for you",
	done: "done",
	failed: "failed",
	stopped: "stopped",
}

/** "3 of 6 · 4 min · $0.31" plus the run's status word. */
export function runProgress(run: AutomationRun, history: readonly HistoryItem[] | undefined, now: number) {
	const finished = run.steps.filter((step) => step.status === "done").length
	const current = run.steps.findIndex((step) => step.status === "running" || step.status === "waiting")
	const elapsed = formatElapsed((run.endedAt ?? now) - run.startedAt)
	const cost = formatCost(runCost(run, history))
	const step = current >= 0 ? `${current + 1} of ${run.steps.length}` : `${finished} of ${run.steps.length}`
	return {
		status: STATUS_WORDS[run.status],
		line: [isLiveRun(run) ? step : "", elapsed, cost].filter(Boolean).join(" · "),
		/** 0–1, for the run bar's progress line. */
		fraction: run.steps.length ? finished / run.steps.length : 0,
		currentStep: current >= 0 ? run.steps[current] : undefined,
	}
}

/** The run that started this thread. */
export function runForThread(runs: readonly AutomationRun[], threadId: string | undefined): AutomationRun | undefined {
	if (!threadId) return undefined
	return runs.find((run) => runThreadIds(run).includes(threadId))
}

export const STEP_STATUS_LABELS: Record<AutomationRunStepStatus, string> = {
	pending: "Not started",
	running: "Running",
	waiting: "Waiting for you",
	done: "Done",
	failed: "Failed",
	stopped: "Stopped",
	skipped: "Skipped",
}
