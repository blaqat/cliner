import {
	type AutomationFix,
	type AutomationRun,
	type AutomationRunStep,
	type AutomationRunStepStatus,
	runActiveMs,
	runThreadIds,
} from "@shared/automations"
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

/** The step a run is on (running or waiting), else the first that didn't finish. */
export function currentStep(run: AutomationRun): { step: AutomationRunStep; number: number } | undefined {
	const live = run.steps.findIndex((step) => step.status === "running" || step.status === "waiting")
	const index = live >= 0 ? live : run.steps.findIndex((step) => step.status !== "done")
	return index >= 0 ? { step: run.steps[index], number: index + 1 } : undefined
}

/** The run's status in a few words: "Running", "Failed at step 3". The task page's header says this. */
export function runStatusText(run: AutomationRun): string {
	const at = currentStep(run)
	switch (run.status) {
		case "running":
			return "Running"
		case "waiting":
			return "Waiting for you"
		case "done":
			return "Done"
		case "failed":
			return at ? `Failed at step ${at.number}` : "Failed"
		case "stopped":
			return at ? `Stopped at step ${at.number}` : "Stopped"
	}
}

/** "4 min · $0.31": the run's time (not counting the pause before a resume) and spend. */
export function runTimeAndCost(run: AutomationRun, history: readonly HistoryItem[] | undefined, now: number): string {
	const cost = formatCost(runCost(run, history))
	const limit = run.costLimit ? ` of $${run.costLimit.toFixed(2)}` : ""
	return [formatElapsed(runActiveMs(run, now)), cost ? `${cost}${limit}` : ""].filter(Boolean).join(" · ")
}

/** 0–1, for the run bar's progress line. */
export function runFraction(run: AutomationRun): number {
	return run.steps.length ? run.steps.filter((step) => step.status === "done").length / run.steps.length : 0
}

/** What the run needs from the user right now, and where to do it. */
export interface RunNeed {
	/** "Approve an edit to src/a.ts", "Pick a plan". */
	text: string
	stepId: string
	/** The thread to open; absent for an Ask you step (answered on the task page). */
	threadId?: string
}

export function runNeeds(run: AutomationRun): RunNeed[] {
	return run.steps.flatMap((step): RunNeed[] => {
		if (step.kind === "checkpoint" && step.status === "waiting")
			return [{ text: step.question?.trim() ? `Pick: ${step.question.trim()}` : "Pick how to go on", stepId: step.id }]
		return step.threads
			.filter((thread) => thread.status === "waiting" && thread.threadId)
			.map((thread) => ({
				text: `${thread.waitingOn ?? "Needs your answer"}${step.threads.length > 1 ? ` (${thread.title})` : ""}`,
				stepId: step.id,
				threadId: thread.threadId,
			}))
	})
}

/** Why a finished run stopped short, and where the fix is: the failed thread's error, else the run's. */
export function runFailure(run: AutomationRun): { message: string; fix?: AutomationFix; stepId?: string } | undefined {
	for (const step of run.steps) {
		if (step.status !== "failed") continue
		const thread = step.threads.find((candidate) => candidate.status === "failed" && candidate.error)
		if (thread) return { message: thread.error as string, fix: thread.fix ?? step.fix, stepId: step.id }
		if (step.error) return { message: step.error, fix: step.fix, stepId: step.id }
	}
	return run.error ? { message: run.error, fix: run.fix } : undefined
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

export const FIX_LABELS: Record<AutomationFix, string> = {
	worktrees: "Open Worktrees settings",
	models: "Open Models settings",
	automation: "Edit the automation",
	folder: "Open folder…",
	repository: "Open folder…",
	commit: "Open Source Control",
}
