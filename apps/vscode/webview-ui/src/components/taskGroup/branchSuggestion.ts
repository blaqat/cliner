import type { TaskGroupSummary } from "@shared/task-groups"
import { sameTag } from "./effectiveThreadTags"

export interface BranchSuggestionInput {
	/** The checked-out branch (extension state `currentBranch`). */
	currentBranch?: string
	taskGroups: TaskGroupSummary[]
	/** The task the composer files into right now (pending pick, or the open thread's own). */
	composerTaskGroupId?: string
	/** Set while the composer is on a task page (its task is fixed there). */
	pageTaskGroupId?: string
}

/**
 * The task the composer should offer to join because it carries the checked-out
 * branch as a branch tag: the most recently updated such task that hasn't been
 * dismissed and isn't already the composer's. Never on a task page.
 */
export function suggestBranchTask({
	currentBranch,
	taskGroups,
	composerTaskGroupId,
	pageTaskGroupId,
}: BranchSuggestionInput): TaskGroupSummary | undefined {
	if (!currentBranch || pageTaskGroupId) return undefined
	const branch = { kind: "branch", value: currentBranch } as const
	const hasBranch = (group: TaskGroupSummary) => group.tags.some((tag) => sameTag(tag, branch))
	// Already in a task on this branch: nothing to suggest, even if a newer one shares it.
	const current = taskGroups.find((group) => group.id === composerTaskGroupId)
	if (current && hasBranch(current)) return undefined
	return [...taskGroups]
		.filter((group) => !group.branchSuggestionDismissed && hasBranch(group))
		.sort((a, b) => b.updatedAt - a.updatedAt)[0]
}

const BRANCH_HINT_DISMISSED_KEY = "cline.taskBranchHintDismissed"
// Holds this session's dismissals even where storage is unavailable.
const sessionDismissed = new Set<string>()

function dismissedBranchHints(): string[] {
	try {
		const value: unknown = JSON.parse(localStorage.getItem(BRANCH_HINT_DISMISSED_KEY) ?? "[]")
		return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []
	} catch {
		return []
	}
}

/** The task page's "current branch isn't linked" hint, dismissed for this task and branch only. */
export function isBranchHintDismissed(taskGroupId: string, branch: string): boolean {
	const key = `${taskGroupId}\n${branch}`
	return sessionDismissed.has(key) || dismissedBranchHints().includes(key)
}

export function dismissBranchHint(taskGroupId: string, branch: string): void {
	const key = `${taskGroupId}\n${branch}`
	sessionDismissed.add(key)
	// Keep the list short: the newest dismissals win.
	const next = [key, ...dismissedBranchHints().filter((entry) => entry !== key)].slice(0, 200)
	try {
		localStorage.setItem(BRANCH_HINT_DISMISSED_KEY, JSON.stringify(next))
	} catch {
		// Storage full or unavailable: the hint just comes back next time.
	}
}
