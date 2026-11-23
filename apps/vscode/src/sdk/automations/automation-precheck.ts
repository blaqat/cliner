import {
	type AutomationFix,
	type AutomationProblem,
	type AutomationStep,
	automationThreads,
	automationWorkspace,
} from "@shared/automations"

export interface PrecheckContext {
	/** The open folder; undefined when none is open. */
	workspace: string | undefined
	/** Whether a new worktree can be made now, and why not. Read only when a step needs one. */
	worktrees: () => Promise<{ available: boolean; reason?: string }>
	/** The task the run starts in already has a worktree in this folder. */
	reuseTaskWorktree?: boolean
	/** Why a thread's model can't run as written; undefined when it can. */
	modelProblem?: (model: string, level: string, mode: "ask" | "act") => string | undefined
}

/** Whether Worktrees settings is where this worktree problem is fixed (off, or mm not set up). */
export function worktreeSettingsFix(reason: string | undefined): boolean {
	return /worktrees are off|mm\.js|mm isn't set up/i.test(reason ?? "")
}

/** Where a worktree failure is fixed: Worktrees settings, or the folder's git repository itself. */
export function worktreeFix(reason: string | undefined): AutomationFix | undefined {
	if (worktreeSettingsFix(reason)) return "worktrees"
	if (/not a git repository/i.test(reason ?? "")) return "repository"
	if (/unknown revision|needed a single revision|ambiguous argument 'HEAD'|does not have any commits/i.test(reason ?? ""))
		return "commit"
	return undefined
}

/** A worktree failure in plain words: git's and mm's messages, said the way the user can act on them. */
export function plainWorktreeReason(reason: string | undefined): string {
	const text = (reason ?? "").trim()
	if (!text) return "a worktree can't be made here."
	if (/mm\.js path:/i.test(text)) return text
	// Today's messages name the switch that's off and how to turn it on; older stored ones didn't.
	if (/^Worktrees are off\b.*\.$/.test(text)) return text
	if (/worktrees are off/i.test(text)) return "worktrees are turned off."
	if (/not a git repository/i.test(text))
		return "this folder isn't a git repository. Open the repository's folder, or initialize git here."
	if (/unknown revision|needed a single revision|ambiguous argument 'HEAD'|does not have any commits/i.test(text))
		return "the repository has no commits yet. Make a first commit in Source Control."
	if (/mm\.js/i.test(text)) return "mm isn't set up. Set the path to mm.js."
	if (/ENOENT|no such file/i.test(text)) return `a file it needs is missing: ${text.replace(/\.$/, "")}.`
	if (/already exists/i.test(text)) return `a worktree folder is in the way: ${text.replace(/\.$/, "")}.`
	return `${text.replace(/\.$/, "")}.`
}

/**
 * What must be fixed before these steps can run, checked before anything starts: a folder for the
 * worktree steps, a worktree that can be made, and models that exist. One problem per cause, naming the
 * steps it blocks, so the start form and a resume say it once.
 */
export async function precheckSteps(steps: readonly AutomationStep[], context: PrecheckContext): Promise<AutomationProblem[]> {
	const problems: AutomationProblem[] = []
	const threads = automationThreads(steps)
	const firstTask = steps.findIndex((step) => step.kind === "task")
	const existingTaskSteps = context.reuseTaskWorktree ? new Set(firstTask < 0 ? steps : steps.slice(0, firstTask)) : undefined
	const worktreeSteps = [
		...new Set(
			threads
				.filter(({ step, thread }) => {
					const scope = automationWorkspace(thread)
					return scope === "thread" || (scope === "task" && !existingTaskSteps?.has(step))
				})
				.map(({ step }) => step),
		),
	]
	if (worktreeSteps.length) {
		const names = worktreeSteps.map((step) => `“${step.title || step.id}”`).join(", ")
		const runsIn = worktreeSteps.length === 1 ? `${names} runs in a new worktree` : `${names} run in new worktrees`
		if (!context.workspace) {
			problems.push({
				message: `${runsIn}, but no folder is open. Open the repository's folder first.`,
				fix: "folder",
				stepId: worktreeSteps[0].id,
			})
		} else {
			const availability = await context.worktrees()
			if (!availability.available) {
				const reason = plainWorktreeReason(availability.reason)
				const fix = worktreeFix(availability.reason)
				problems.push({
					message: /^[A-Z]/.test(reason) ? `${runsIn}. ${reason}` : `${runsIn}, but ${reason}`,
					...(fix ? { fix } : {}),
					stepId: worktreeSteps[0].id,
				})
			}
		}
	}
	if (context.modelProblem) {
		for (const { step, thread } of threads) {
			const problem = context.modelProblem(thread.model, thread.level, thread.mode)
			if (problem)
				problems.push({
					message: `“${thread.title || step.title || thread.id}”: ${problem}`,
					fix: "models",
					stepId: step.id,
				})
		}
	}
	return problems
}
