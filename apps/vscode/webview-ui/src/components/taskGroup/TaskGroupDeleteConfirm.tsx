import {
	type TaskGroupDeletePreview,
	TaskGroupDeleteRequest,
	type TaskGroupDeleteResult,
	type TaskGroupDeleteTaskWorktree,
} from "@shared/proto/cline/task_group_delete"
import { type ReactNode, useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { TaskGroupDeleteServiceClient } from "@/services/grpc-client"

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`

/** How many noteworthy threads the confirm lists before "and N more". */
const LISTED = 4

/** The task worktree holds something removing it discards: files never copied, or Git work only it has. */
const taskWorktreeLoses = (worktree: TaskGroupDeleteTaskWorktree | undefined) =>
	!!worktree && (worktree.losses > 0 || !!worktree.refWarning)

interface TaskGroupDeleteConfirmProps {
	taskGroupId: string
	onCancel: () => void
	/** The task is gone (either way): leave its page. */
	onDeleted: () => void
	/** Closes the confirm and shows the task worktree section, to copy its changes first. */
	onShowTaskWorktree?: () => void
}

function DetailLine({ icon, warning, children }: { icon: string; warning?: boolean; children: ReactNode }) {
	return (
		<li className="flex min-w-0 items-start gap-1.5">
			<span
				aria-hidden
				className={`codicon codicon-${icon} shrink-0 text-[12px]! leading-4 ${warning ? "text-warning" : "text-description"}`}
			/>
			<span className="min-w-0 flex-1 break-words leading-4">{children}</span>
		</li>
	)
}

/**
 * The inline confirm under the task page's header for ⋯ › Delete task…: delete just the task (its
 * threads stay, unfiled) or the task with all its threads. Before offering either it asks the host
 * what that would stop and lose: running threads (stopped), worktrees with work never copied to the
 * workspace (discarded, named here), threads busy in another window (blocks it until stopped). A task
 * worktree is removed first with either choice, through the same checks as its own Remove, so kept
 * threads continue in the workspace rather than in a worktree that's gone.
 */
export function TaskGroupDeleteConfirm({ taskGroupId, onCancel, onDeleted, onShowTaskWorktree }: TaskGroupDeleteConfirmProps) {
	const [preview, setPreview] = useState<TaskGroupDeletePreview | undefined>()
	const [checkError, setCheckError] = useState<string>()
	const [busy, setBusy] = useState(false)
	const [blocked, setBlocked] = useState<string>()
	// A worktree warning the preview couldn't foresee (Git work found at removal): that choice's next try discards.
	const [discardAllAfterWarning, setDiscardAllAfterWarning] = useState(false)
	const [discardOnlyAfterWarning, setDiscardOnlyAfterWarning] = useState(false)

	// Bumped by "Check again" once a thread running here or elsewhere has stopped.
	const [checks, setChecks] = useState(0)
	useEffect(() => {
		let live = true
		void checks
		TaskGroupDeleteServiceClient.previewTaskGroupDelete(TaskGroupDeleteRequest.create({ id: taskGroupId }))
			.then((fresh) => {
				if (!live) return
				setPreview(fresh)
				setBlocked(undefined)
			})
			.catch((error) => live && setCheckError(error instanceof Error ? error.message : String(error)))
		return () => {
			live = false
		}
	}, [taskGroupId, checks])

	const threads = preview?.threads
	const worktree = preview?.taskWorktree
	const losing = threads?.filter((thread) => thread.worktreeLosses > 0) ?? []
	const busyElsewhere = threads?.filter((thread) => thread.busyElsewhere) ?? []
	const discardAll = losing.length > 0 || taskWorktreeLoses(worktree) || discardAllAfterWarning
	const discardOnly = taskWorktreeLoses(worktree) || discardOnlyAfterWarning
	const worktreeInUse = !!worktree && (worktree.busyElsewhere || worktree.runningHere.length > 0)

	/** Shows why nothing was deleted; when nothing new is listed, the worktree manager itself warned, so offer to discard. */
	const stopped = (result: TaskGroupDeleteResult, offerDiscard: () => void) => {
		setBusy(false)
		setBlocked(result.blocked || "Nothing was deleted.")
		if (!result.preview) return
		setPreview(result.preview)
		const fresh = result.preview
		const listed =
			fresh.threads.some((thread) => thread.busyElsewhere || thread.worktreeLosses > 0) ||
			(!!fresh.taskWorktree &&
				(fresh.taskWorktree.busyElsewhere ||
					fresh.taskWorktree.runningHere.length > 0 ||
					taskWorktreeLoses(fresh.taskWorktree)))
		if (!listed) offerDiscard()
	}

	const failed = (prefix: string) => (error: unknown) => {
		setBusy(false)
		setBlocked(`${prefix}: ${error instanceof Error ? error.message : String(error)}`)
	}

	const deleteTaskOnly = () => {
		setBusy(true)
		setBlocked(undefined)
		TaskGroupDeleteServiceClient.deleteTaskGroupOnly(
			TaskGroupDeleteRequest.create({
				id: taskGroupId,
				discardWorktreeWork: discardOnly,
				// Discards only what this preview showed; a worktree changed since gets a fresh look first.
				removalConfirmation: discardOnly ? (preview?.removalConfirmation ?? "") : "",
			}),
		)
			.then((result) => (result.deleted ? onDeleted() : stopped(result, () => setDiscardOnlyAfterWarning(true))))
			.catch(failed("Couldn't delete the task"))
	}

	const deleteAll = () => {
		setBusy(true)
		setBlocked(undefined)
		TaskGroupDeleteServiceClient.deleteTaskGroupWithThreads(
			TaskGroupDeleteRequest.create({
				id: taskGroupId,
				discardWorktreeWork: discardAll,
				removalConfirmation: discardAll ? (preview?.removalConfirmation ?? "") : "",
			}),
		)
			.then((result) => (result.deleted ? onDeleted() : stopped(result, () => setDiscardAllAfterWarning(true))))
			.catch(failed("Couldn't delete"))
	}

	const count = threads?.length ?? 0
	const asides = threads?.filter((thread) => thread.aside).length ?? 0
	const subagents = threads?.reduce((sum, thread) => sum + thread.subagents, 0) ?? 0
	const noteworthy = threads?.filter((thread) => thread.busyElsewhere || thread.running || thread.worktreeNote) ?? []
	const includes = [asides && plural(asides, "side thread"), subagents && plural(subagents, "subagent thread")].filter(Boolean)
	const runningHere = worktree?.runningHere ?? []
	const onlyReason = worktree?.busyElsewhere
		? "A thread using the task worktree is running in another window. Stop it there first."
		: runningHere.length
			? "Stop the threads running in the task worktree first."
			: undefined

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
				<span>
					{count === 1
						? "Delete this task? You can keep its thread (it stays, just unfiled) or delete it too"
						: `Delete this task? You can keep its ${count} threads (they stay, just unfiled) or delete them too`}
					{includes.length ? ` (includes ${includes.join(" and ")})` : ""}. Notes are deleted either way.
				</span>
			)}
			{worktree && (
				<ul className="m-0 flex list-none flex-col gap-0.5 p-0" data-testid="task-group-delete-worktree">
					<DetailLine icon="repo-forked">
						The task worktree{worktree.branch ? ` (${worktree.branch})` : ""} is removed first
						{count > 0 ? " either way. Kept threads continue in your workspace." : "."}
					</DetailLine>
					{worktree.busyElsewhere && (
						<DetailLine icon="warning" warning>
							A thread using it is running in another window. Stop it there first.
						</DetailLine>
					)}
					{runningHere.length > 0 && (
						<DetailLine icon="sync">
							<span className="font-medium">{runningHere.map((title) => `“${title}”`).join(", ")}</span>{" "}
							{runningHere.length === 1 ? "is" : "are"} running in it. Deleting the threads stops{" "}
							{runningHere.length === 1 ? "it" : "them"}; to keep them, stop{" "}
							{runningHere.length === 1 ? "it" : "them"} first.
						</DetailLine>
					)}
					{worktree.note && (
						<DetailLine icon="warning" warning>
							{worktree.note}
							{onShowTaskWorktree && (
								<>
									{" "}
									<button
										className="cursor-pointer border-0 bg-transparent p-0 text-link underline hover:text-link-hover"
										data-testid="task-group-delete-show-worktree"
										onClick={onShowTaskWorktree}
										type="button">
										Copy them first
									</button>
								</>
							)}
						</DetailLine>
					)}
					{worktree.refWarning && (
						<DetailLine icon="warning" warning>
							<span className="whitespace-pre-wrap">{worktree.refWarning}</span>
						</DetailLine>
					)}
				</ul>
			)}
			{threads && count > 0 && (
				<>
					{noteworthy.length > 0 && (
						<ul className="m-0 flex list-none flex-col gap-0.5 p-0" data-testid="task-group-delete-details">
							{noteworthy.slice(0, LISTED).map((thread) => (
								<DetailLine
									icon={thread.busyElsewhere || thread.worktreeLosses ? "warning" : "sync"}
									key={thread.id}
									warning={thread.busyElsewhere || thread.worktreeLosses > 0}>
									<span className="font-medium">“{thread.title}”</span>{" "}
									{thread.busyElsewhere
										? "is running in another window. Stop it there first."
										: thread.running && thread.worktreeNote
											? `is running; deleting stops it. It also ${thread.worktreeNote}`
											: thread.running
												? "is running; deleting stops it."
												: thread.worktreeNote}
								</DetailLine>
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
				<span className="whitespace-pre-wrap text-error" data-testid="task-group-delete-blocked">
					{blocked}
				</span>
			)}
			<div className="flex flex-wrap items-center gap-1.5">
				{threads && count > 0 && (
					<Button
						data-testid="task-group-delete-all"
						disabled={busy || busyElsewhere.length > 0 || !!worktree?.busyElsewhere}
						onClick={deleteAll}
						size="xs"
						title={
							busyElsewhere.length || worktree?.busyElsewhere
								? "Stop the threads running in another window first."
								: undefined
						}
						variant="danger">
						{busy
							? "Deleting…"
							: discardAll
								? `Delete task and ${plural(count, "thread")}, discard changes`
								: `Delete task and its ${plural(count, "thread")}`}
					</Button>
				)}
				{(busyElsewhere.length > 0 || worktreeInUse) && (
					<Button
						data-testid="task-group-delete-recheck"
						disabled={busy}
						onClick={() => setChecks((count) => count + 1)}
						size="xs"
						variant="secondary">
						Check again
					</Button>
				)}
				<Button
					data-testid="task-group-delete-only"
					disabled={busy || (!threads && !checkError) || !!onlyReason}
					onClick={deleteTaskOnly}
					size="xs"
					title={onlyReason}
					variant={threads && count > 0 ? "secondary" : "danger"}>
					{threads && count > 0
						? discardOnly
							? "Delete task only, discard worktree changes"
							: `Delete task only (keep ${count === 1 ? "its thread" : "threads"})`
						: discardOnly
							? "Delete, discard worktree changes"
							: "Delete"}
				</Button>
				<Button disabled={busy} onClick={onCancel} size="xs" variant="secondary">
					Cancel
				</Button>
			</div>
		</div>
	)
}
