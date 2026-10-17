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
