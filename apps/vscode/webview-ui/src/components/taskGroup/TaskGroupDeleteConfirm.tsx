import { DeleteTaskGroupRequest } from "@shared/proto/cline/task_group"
import { TaskGroupDeleteRequest, type TaskGroupDeleteThread } from "@shared/proto/cline/task_group_delete"
import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { TaskGroupDeleteServiceClient, TaskGroupServiceClient } from "@/services/grpc-client"

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`

/** How many noteworthy threads the confirm lists before "and N more". */
const LISTED = 4

interface TaskGroupDeleteConfirmProps {
	taskGroupId: string
	onCancel: () => void
	/** The task is gone (either way): leave its page. */
	onDeleted: () => void
}

/**
 * The inline confirm under the task page's header for ⋯ › Delete task…: delete just the task (its
 * threads stay, unfiled) or the task with all its threads. Before offering the second it asks the
 * host what that would stop and lose: running threads (stopped), worktrees with work never copied
 * to the workspace (discarded, named here), threads busy in another window (blocks it until stopped).
 */
export function TaskGroupDeleteConfirm({ taskGroupId, onCancel, onDeleted }: TaskGroupDeleteConfirmProps) {
	const [threads, setThreads] = useState<TaskGroupDeleteThread[] | undefined>()
	const [checkError, setCheckError] = useState<string>()
	const [busy, setBusy] = useState(false)
	const [blocked, setBlocked] = useState<string>()
	// A worktree warning the preview couldn't foresee (submodule caches): the next try discards.
	const [discardAfterWarning, setDiscardAfterWarning] = useState(false)

	useEffect(() => {
		let live = true
		TaskGroupDeleteServiceClient.previewTaskGroupDelete(TaskGroupDeleteRequest.create({ id: taskGroupId }))
			.then((preview) => live && setThreads(preview.threads))
			.catch((error) => live && setCheckError(error instanceof Error ? error.message : String(error)))
		return () => {
			live = false
		}
	}, [taskGroupId])

	const deleteTaskOnly = () => {
		setBusy(true)
		TaskGroupServiceClient.deleteTaskGroup(DeleteTaskGroupRequest.create({ id: taskGroupId }))
			.then(onDeleted)
			.catch((error) => {
				setBusy(false)
				setBlocked(`Couldn't delete the task: ${error instanceof Error ? error.message : String(error)}`)
			})
	}

	const losing = threads?.filter((thread) => thread.worktreeLosses > 0) ?? []
	const busyElsewhere = threads?.filter((thread) => thread.busyElsewhere) ?? []
	const discard = losing.length > 0 || discardAfterWarning

	const deleteAll = () => {
		setBusy(true)
		setBlocked(undefined)
		TaskGroupDeleteServiceClient.deleteTaskGroupWithThreads(
			TaskGroupDeleteRequest.create({ id: taskGroupId, discardWorktreeWork: discard }),
		)
			.then((result) => {
				if (result.deleted) return onDeleted()
				setBusy(false)
				setBlocked(result.blocked || "Nothing was deleted.")
				if (result.preview) setThreads(result.preview.threads)
				// Nothing new to list and nothing busy: the worktree manager itself warned, so offer to discard.
				const fresh = result.preview?.threads ?? []
				if (!fresh.some((thread) => thread.busyElsewhere || thread.worktreeLosses > 0)) setDiscardAfterWarning(true)
			})
			.catch((error) => {
				setBusy(false)
				setBlocked(`Couldn't delete: ${error instanceof Error ? error.message : String(error)}`)
			})
	}

	const count = threads?.length ?? 0
	const asides = threads?.filter((thread) => thread.aside).length ?? 0
	const subagents = threads?.reduce((sum, thread) => sum + thread.subagents, 0) ?? 0
	const noteworthy = threads?.filter((thread) => thread.busyElsewhere || thread.running || thread.worktreeNote) ?? []
	const includes = [asides && plural(asides, "side thread"), subagents && plural(subagents, "subagent thread")].filter(Boolean)

	return (
		<div
			className="mx-4 mb-1 flex flex-col gap-1.5 rounded-xs border border-error/50 bg-error/10 px-2 py-1.5 text-xs"
			data-testid="task-group-delete-confirm"
			role="alert">
			{!threads && !checkError && <span className="text-description">Checking this task’s threads…</span>}
			{checkError && (
				<span>
					Couldn’t check this task’s threads ({checkError}), so only the task can be deleted. Its threads stay, unfiled.
				</span>
			)}
			{threads && count === 0 && <span>Delete this task? It has no threads. Its notes are deleted.</span>}
			{threads && count > 0 && (
				<>
					<span>
						Delete this task? You can keep its {plural(count, "thread")} (they stay, just unfiled) or delete them too
						{includes.length ? ` (includes ${includes.join(" and ")})` : ""}. Notes are deleted either way.
					</span>
					{noteworthy.length > 0 && (
						<ul className="m-0 flex list-none flex-col gap-0.5 p-0" data-testid="task-group-delete-details">
							{noteworthy.slice(0, LISTED).map((thread) => (
								<li className="flex min-w-0 items-start gap-1.5" key={thread.id}>
									<span
										aria-hidden
										className={`codicon shrink-0 text-[12px]! leading-4 ${
											thread.busyElsewhere || thread.worktreeLosses
												? "codicon-warning text-warning"
												: "codicon-debug-stop text-description"
										}`}
									/>
									<span className="min-w-0 flex-1 break-words leading-4">
										<span className="font-medium">“{thread.title}”</span>{" "}
										{thread.busyElsewhere
											? "is running in another window. Stop it there first."
											: [thread.running && "is running; deleting stops it.", thread.worktreeNote]
													.filter(Boolean)
													.join(" ")}
									</span>
								</li>
							))}
							{noteworthy.length > LISTED && (
								<li className="text-description">and {noteworthy.length - LISTED} more</li>
							)}
						</ul>
					)}
					<span className="text-description">Deleted threads can’t be restored.</span>
				</>
			)}
			{blocked && (
				<span className="text-error" data-testid="task-group-delete-blocked">
					{blocked}
				</span>
			)}
			<div className="flex flex-wrap items-center gap-1.5">
				{threads && count > 0 && (
					<Button
						data-testid="task-group-delete-all"
						disabled={busy || busyElsewhere.length > 0}
						onClick={deleteAll}
						size="xs"
						title={busyElsewhere.length ? "Stop the threads running in another window first." : undefined}
						variant="danger">
						{busy
							? "Deleting…"
							: discard
								? `Delete task and ${plural(count, "thread")}, discard changes`
								: `Delete task and its ${plural(count, "thread")}`}
					</Button>
				)}
				<Button
					data-testid="task-group-delete-only"
					disabled={busy || (!threads && !checkError)}
					onClick={deleteTaskOnly}
					size="xs"
					variant={threads && count > 0 ? "secondary" : "danger"}>
					{threads && count > 0 ? `Delete task only (keep ${count === 1 ? "its thread" : "threads"})` : "Delete"}
				</Button>
				<Button disabled={busy} onClick={onCancel} size="xs" variant="secondary">
					Cancel
				</Button>
			</div>
		</div>
	)
}
