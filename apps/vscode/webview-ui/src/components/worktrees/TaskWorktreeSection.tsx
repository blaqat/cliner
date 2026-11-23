import { useState } from "react"
import { LinkButton } from "@/components/common/LinkButton"
import { ThreadWorktreeActions } from "@/components/worktrees/ThreadWorktreeActions"
import { threadWorktreeAction, useWorktree, worktreeErrorText } from "@/components/worktrees/useWorktree"
import { useExtensionState } from "@/context/ExtensionStateContext"

export function useTaskWorktree(taskGroupId: string) {
	const worktree = useWorktree(undefined, taskGroupId)
	const [creating, setCreating] = useState(false)
	const [message, setMessage] = useState<{ text: string; error?: boolean }>()
	const create = async () => {
		setCreating(true)
		setMessage(undefined)
		try {
			await threadWorktreeAction("createTaskWorktree", undefined, undefined, false, taskGroupId)
			await worktree.refresh()
		} catch (error) {
			setMessage({ text: worktreeErrorText(error), error: true })
		} finally {
			setCreating(false)
		}
	}
	return { ...worktree, creating, create, message, setMessage, taskGroupId }
}

export function TaskWorktreeSection({
	worktree,
	refreshKey,
}: {
	worktree: ReturnType<typeof useTaskWorktree>
	refreshKey: string
}) {
	const { navigateToSettings } = useExtensionState()
	const { state, message, setMessage, creating, error } = worktree
	const mapping = state?.mapping
	const text = message?.text ?? error
	if (!mapping && !text && !creating) return null

	return (
		<section aria-label="Task worktree" className="mx-4 my-2 rounded-xs border border-editor-group-border p-1">
			<h2 className="m-0 px-2 pt-1 text-xs font-medium">Task worktree</h2>
			{creating && (
				<p className="m-0 px-2 py-1 text-xs text-description" role="status">
					Creating worktree…
				</p>
			)}
			{text && (
				<p
					className="m-0 px-2 py-1 text-xs text-description wrap-anywhere"
					role={message?.error || error ? "alert" : "status"}>
					{text}{" "}
					{message?.error && !state?.taskWorktreeElsewhere && (
						<LinkButton onClick={() => navigateToSettings("worktrees")}>Worktree settings</LinkButton>
					)}
					{error && <LinkButton onClick={() => void worktree.refresh(true)}>Try again</LinkButton>}
				</p>
			)}
			{mapping && state?.taskWorktreeElsewhere && (
				<p className="m-0 px-2 py-1 text-xs text-description">
					This task’s worktree belongs to another workspace.{" "}
					<LinkButton
						onClick={() => {
							void threadWorktreeAction(
								"openTaskWorkspace",
								undefined,
								undefined,
								false,
								worktree.taskGroupId,
							).catch((error) => setMessage({ text: worktreeErrorText(error), error: true }))
						}}>
						Open its workspace
					</LinkButton>
				</p>
			)}
			{mapping && !state?.taskWorktreeElsewhere && (
				<ThreadWorktreeActions
					key={mapping.createdAt}
					mapping={mapping}
					onChanged={worktree.refresh}
					onRemoved={(text) => setMessage({ text })}
					refreshKey={refreshKey}
					threadId=""
				/>
			)}
		</section>
	)
}
