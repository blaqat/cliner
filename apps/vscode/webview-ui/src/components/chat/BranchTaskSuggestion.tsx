import { SetThreadTaskGroupRequest, UpdateTaskGroupRequest } from "@shared/proto/cline/task_group"
import type { TaskGroupSummary } from "@shared/task-groups"
import { useState } from "react"
import { suggestBranchTask } from "@/components/taskGroup/branchSuggestion"
import { setComposerTaskGroup, useComposerPageTaskGroup, useComposerTaskGroup } from "@/components/taskGroup/composerTaskGroup"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { TaskGroupServiceClient } from "@/services/grpc-client"

/**
 * The task the composer should offer for the checked-out branch, and whether it
 * would move the thread (it is already in another task) or add it (no task).
 */
export function useBranchTaskSuggestion(): { group: TaskGroupSummary; verb: "Add to" | "Move to" } | undefined {
	const { currentBranch, currentTaskItem, taskGroups } = useExtensionState()
	const pendingId = useComposerTaskGroup()
	const pageId = useComposerPageTaskGroup()
	// Mirrors the task pill: an open thread shows its own task, a new thread the pending pick.
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
	return group ? { group, verb: composerTaskGroupId ? "Move to" : "Add to" } : undefined
}

/**
 * Dashed ghost chip beside the composer's task pill: "Add to ⎇ <task>?" when the
 * checked-out branch is tagged on a task this composer isn't in. Click files the
 * thread (or the next new thread) into it; ✕ stops suggesting that task.
 */
export const BranchTaskSuggestion = () => {
	const { currentTaskItem } = useExtensionState()
	const suggestion = useBranchTaskSuggestion()
	// Optimistic: hide right away; the dismissal arrives in `taskGroups` after the round trip.
	const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set())
	if (!suggestion || dismissed.has(suggestion.group.id)) return null
	const { group, verb } = suggestion
	const threadId = currentTaskItem?.id

	const accept = () => {
		if (!threadId) {
			setComposerTaskGroup(group.id)
			return
		}
		void TaskGroupServiceClient.setThreadTaskGroup(
			SetThreadTaskGroupRequest.create({ threadId, taskGroupId: group.id }),
		).catch((error) => console.error("Failed to move thread to task:", error))
	}
	const dismiss = () => {
		setDismissed((current) => new Set(current).add(group.id))
		void TaskGroupServiceClient.updateTaskGroup(
			UpdateTaskGroupRequest.create({ id: group.id, branchSuggestionDismissed: true }),
		).catch((error) => console.error("Failed to dismiss branch suggestion:", error))
	}

	return (
		<span
			className="flex h-4.5 min-w-[90px] max-w-44 shrink items-center overflow-hidden rounded-full border border-dashed border-(--vscode-charts-green)/50 text-[11px] leading-none whitespace-nowrap text-description"
			data-shrink=""
			data-testid="branch-task-suggestion">
			<button
				aria-label={`${verb} task ${group.title}, which has this branch`}
				className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-1 border-0 bg-transparent pr-0.5 pl-1.5 text-inherit hover:text-foreground focus-visible:outline-1 focus-visible:outline-(--vscode-focusBorder)"
				onClick={accept}
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
				className="flex h-full shrink-0 cursor-pointer items-center border-0 bg-transparent pr-1 pl-0.5 text-inherit opacity-70 hover:opacity-100 focus-visible:outline-1 focus-visible:outline-(--vscode-focusBorder)"
				onClick={dismiss}
				title="Don't suggest this task again"
				type="button">
				<span aria-hidden className="codicon codicon-close text-[10px]!" />
			</button>
		</span>
	)
}
