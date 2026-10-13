import type { HistoryItem } from "@shared/HistoryItem"
import type { TaskGroupSummary, TaskTag } from "@shared/task-groups"
import { buildThreadPath } from "@/components/chat/chat-view/utils/threadUtils"

export const sameTag = (a: Pick<TaskTag, "kind" | "value">, b: Pick<TaskTag, "kind" | "value">) =>
	a.kind === b.kind && a.value.toLowerCase() === b.value.toLowerCase()

export interface EffectiveTag {
	tag: TaskTag
	/** Comes from the thread's task, not the thread itself. */
	inherited: boolean
	/** Title of the task an inherited tag comes from. */
	taskTitle?: string
}

/**
 * A thread's own tags followed by its task's, derived on demand (never copied onto
 * the thread). The task is the one the breadcrumb shows: the thread's own
 * `taskGroupId`, or for a subagent that of its nearest non-subagent ancestor.
 * Own tags come first; a tag on both is listed once, as the thread's own.
 */
export function effectiveThreadTags(
	item: HistoryItem,
	taskHistory: readonly HistoryItem[] | undefined,
	taskGroups: readonly TaskGroupSummary[] | undefined,
): EffectiveTag[] {
	const own = item.tags ?? []
	const result: EffectiveTag[] = own.map((tag) => ({ tag, inherited: false }))
	if (!taskGroups?.length) return result
	// Only a subagent needs the ancestor walk; everything else owns its membership.
	const groupId = item.isSubagent ? buildThreadPath(item, taskHistory ?? []).taskGroupId : item.taskGroupId
	const group = groupId ? taskGroups.find((candidate) => candidate.id === groupId) : undefined
	if (!group) return result
	const inherited: EffectiveTag[] = []
	for (const tag of group.tags ?? []) {
		if ([...own, ...inherited.map((entry) => entry.tag)].some((other) => sameTag(other, tag))) continue
		inherited.push({ tag, inherited: true, taskTitle: group.title })
	}
	return [...result, ...inherited]
}
