import { useState } from "react"
import { threadWorktreeAction, useWorktree } from "./useWorktree"

export function WorktreeBadge({ threadId }: { threadId?: string }) {
	const { state } = useWorktree(threadId)
	return state?.mapping ? (
		<span aria-label="Thread runs in a worktree" className="text-description" role="img" title={state.mapping.cwd}>
			⑂
		</span>
	) : null
}

export function ThreadWorktreeActions({ threadId }: { threadId: string }) {
	const { state, refresh, error } = useWorktree(threadId)
	const [message, setMessage] = useState<string>()
	const [conflicts, setConflicts] = useState<string[]>([])
	const [confirmRemove, setConfirmRemove] = useState(false)
	const [busy, setBusy] = useState(false)
	const act = async (action: string) => {
		setBusy(true)
		try {
			const result = await threadWorktreeAction(action, threadId, undefined, action === "remove" && confirmRemove)
			setMessage(result.warning || result.message)
			setConflicts(result.conflicts ?? [])
			setConfirmRemove(action === "remove" && !!result.warning)
			await refresh()
		} catch (error) {
			setMessage(String(error))
		} finally {
			setBusy(false)
		}
	}
	if (!state?.mapping) return null
	return (
		<div className="border-b border-(--vscode-panel-border) pb-1 mb-1">
			<div className="px-2 py-1 text-xs text-description break-all">⑂ {state.mapping.branch}</div>
			{[
				["open", "Open in new window"],
				["bring", "Bring here"],
				["undo", "Undo bring-in"],
				["takeOver", "Take over branch"],
				["remove", confirmRemove ? "Remove and discard changes" : "Remove worktree"],
			].map(([action, label]) => (
				<button
					className="block w-full text-left border-0 rounded-xs bg-transparent text-foreground px-2 py-1 text-xs hover:bg-list-hover disabled:opacity-50"
					disabled={busy}
					key={action}
					onClick={() => void act(action)}
					role="menuitem"
					type="button">
					{label}
				</button>
			))}
			{confirmRemove && (
				<button
					className="text-xs px-2"
					onClick={() => {
						setConfirmRemove(false)
						setMessage(undefined)
					}}
					type="button">
					Cancel removal
				</button>
			)}
			{(message || error) && (
				<p className="text-xs px-2 break-words" role="status">
					{message || error}
				</p>
			)}
			{conflicts.length > 0 && (
				<ul className="text-xs px-4">
					{conflicts.map((file) => (
						<li key={file}>Conflict: {file}</li>
					))}
				</ul>
			)}
		</div>
	)
}
