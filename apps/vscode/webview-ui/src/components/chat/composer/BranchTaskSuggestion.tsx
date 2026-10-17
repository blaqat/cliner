import { SetThreadTaskGroupRequest, UpdateTaskGroupRequest } from "@shared/proto/cline/task_group"
import type { TaskGroupSummary } from "@shared/task-groups"
import { useState } from "react"
import { suggestBranchTask } from "@/components/taskGroup/branchSuggestion"
import { setComposerTaskGroup, useComposerPageTaskGroup, useComposerTaskGroup } from "@/components/taskGroup/composerTaskGroup"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { TaskGroupServiceClient } from "@/services/grpc-client"

export interface BranchTaskSuggestionOffer {
	group: TaskGroupSummary
	verb: "Add to" | "Move to"
	/** Files the thread (or the next new thread) into the task. */
	accept: () => void
	/** Stops suggesting this task. */
	dismiss: () => void
}

/**
 * The task the composer should offer for the checked-out branch, and whether it would move the thread
 * (it is already in another task) or add it (no task). Call it from something that stays mounted (the
 * where pill), so the optimistic dismissal survives the popover closing.
 */
export function useBranchTaskSuggestion(): BranchTaskSuggestionOffer | undefined {
	const { currentBranch, currentTaskItem, taskGroups } = useExtensionState()
	const pendingId = useComposerTaskGroup()
	const pageId = useComposerPageTaskGroup()
	// Optimistic: hide right away; the dismissal arrives in `taskGroups` after the round trip.
	const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set())
	// Mirrors the where pill: an open thread shows its own task, a new thread the pending pick.
	const threadId = currentTaskItem?.id
	const composerTaskGroupId = threadId ? currentTaskItem?.taskGroupId || undefined : pendingId
	const group = currentTaskItem?.isSubagent
		? undefined
		: suggestBranchTask({
				currentBranch,
				taskGroups: taskGroups ?? [],
				composerTaskGroupId,
				pageTaskGroupId: pageId,
			})
	if (!group || dismissed.has(group.id)) {
		return undefined
	}
	return {
		group,
		verb: composerTaskGroupId ? "Move to" : "Add to",
		accept: () => {
			if (!threadId) {
				setComposerTaskGroup(group.id)
				return
			}
			void TaskGroupServiceClient.setThreadTaskGroup(
				SetThreadTaskGroupRequest.create({ threadId, taskGroupId: group.id }),
			).catch((error) => console.error("Failed to move thread to task:", error))
		},
		dismiss: () => {
			setDismissed((current) => new Set(current).add(group.id))
			void TaskGroupServiceClient.updateTaskGroup(
				UpdateTaskGroupRequest.create({ id: group.id, branchSuggestionDismissed: true }),
			).catch((error) => console.error("Failed to dismiss branch suggestion:", error))
		},
	}
}

/**
 * Dashed ghost row at the top of the where pill's menu: "Add to ⎇ <task>?" when the checked-out
 * branch is tagged on a task this composer isn't in. Click accepts; ✕ stops suggesting that task.
 */
export const BranchTaskSuggestion = ({
	suggestion,
	onAccept,
}: {
	suggestion: BranchTaskSuggestionOffer
	/** Runs after accepting (the pill closes its menu). */
	onAccept?: () => void
}) => {
	const { group, verb } = suggestion
	return (
		<div
			className="mb-1 flex h-6 items-center overflow-hidden rounded-xs border border-dashed border-(--vscode-charts-green)/50 text-xs whitespace-nowrap text-description"
			data-testid="branch-task-suggestion">
			<button
				aria-label={`${verb} task ${group.title}, which has this branch`}
				className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-1 border-0 bg-transparent pr-0.5 pl-2 text-left text-inherit hover:bg-list-hover hover:text-foreground focus-visible:bg-list-hover focus-visible:outline-none"
				onClick={() => {
					suggestion.accept()
					onAccept?.()
				}}
				role="menuitem"
				title={`${verb} the task "${group.title}" (it has the branch you're on)`}
				type="button">
				<span className="shrink-0">{verb}</span>
				<span aria-hidden className="shrink-0 text-(--vscode-charts-green)">
					⎇
				</span>
				<span className="truncate">{group.title}?</span>
			</button>
			<button
				aria-label={`Don't suggest ${group.title} again`}
				className="flex h-full shrink-0 cursor-pointer items-center border-0 bg-transparent px-1.5 text-inherit opacity-70 hover:bg-list-hover hover:opacity-100 focus-visible:bg-list-hover focus-visible:outline-none"
				onClick={suggestion.dismiss}
				role="menuitem"
				title="Don't suggest this task again"
				type="button">
				<span aria-hidden className="codicon codicon-close text-[11px]!" />
			</button>
		</div>
	)
}
