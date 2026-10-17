import { useState } from "react"
import { InlineNotice } from "@/components/common/InlineNotice"
import { MENU_HEADING_CLASS, MENU_ICON_CLASS, MENU_ITEM_CLASS, MENU_SEPARATOR_CLASS } from "@/components/common/menuStyles"
import { cn } from "@/lib/utils"
import { threadWorktreeAction, useWorktree } from "./useWorktree"

export function WorktreeBadge({ threadId }: { threadId?: string }) {
	const { state } = useWorktree(threadId)
	return state?.mapping ? (
		<span
			aria-label="Thread runs in a worktree"
			className="codicon codicon-repo-forked shrink-0 text-[12px]! text-description"
			role="img"
			title={state.mapping.cwd}
		/>
	) : null
}

/** The thread header ⋯ menu's worktree section: the branch, then the worktree actions. */
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
	const actions: [action: string, label: string, icon: string][] = [
		["open", "Open in new window", "empty-window"],
		["bring", "Bring here", "arrow-down"],
		["undo", "Undo bring-in", "discard"],
		["takeOver", "Take over branch", "git-branch"],
		["remove", confirmRemove ? "Remove and discard changes" : "Remove worktree", "trash"],
	]
	return (
		<div>
			<div className={cn(MENU_HEADING_CLASS, "flex items-center gap-1 normal-case tracking-normal")}>
				<span aria-hidden className="codicon codicon-repo-forked text-[11px]!" />
				<span className="ph-no-capture min-w-0 truncate font-mono">{state.mapping.branch}</span>
			</div>
			{actions.map(([action, label, icon]) => (
				<button
					className={cn(MENU_ITEM_CLASS, action === "remove" && confirmRemove && "text-error")}
					disabled={busy}
					key={action}
					onClick={() => void act(action)}
					role="menuitem"
					type="button">
					<span aria-hidden className={cn(MENU_ICON_CLASS, `codicon-${icon}`)} />
					{label}
				</button>
			))}
			{confirmRemove && (
				<button
					className={MENU_ITEM_CLASS}
					onClick={() => {
						setConfirmRemove(false)
						setMessage(undefined)
					}}
					role="menuitem"
					type="button">
					<span aria-hidden className={cn(MENU_ICON_CLASS, "codicon-close")} />
					Cancel removal
				</button>
			)}
			{(message || error || conflicts.length > 0) && (
				<InlineNotice className="mx-1 my-1" role="status" tone={confirmRemove || conflicts.length ? "warning" : "info"}>
					{message || error}
					{conflicts.length > 0 && (
						<ul className="m-0 mt-1 list-none p-0 font-mono text-[11px]">
							{conflicts.map((file) => (
								<li className="break-all" key={file}>
									Conflict: {file}
								</li>
							))}
						</ul>
					)}
				</InlineNotice>
			)}
			<div className={MENU_SEPARATOR_CLASS} />
		</div>
	)
}
