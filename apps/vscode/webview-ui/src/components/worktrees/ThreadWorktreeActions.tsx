import { useState } from "react"
import { MENU_ROW_CLASS } from "@/components/chat/composer/menuKeyboard"
import { InlineNotice } from "@/components/common/InlineNotice"
import { MENU_ICON_CLASS } from "@/components/common/menuStyles"
import { cn } from "@/lib/utils"
import { threadWorktreeAction, useWorktree } from "./useWorktree"

/**
 * The worktree actions for a thread that runs in one, shown in the composer's workspace menu under
 * the branch (the green workspace button is where worktree things live). `onChanged` refreshes the
 * caller's worktree state, so the button follows a removal.
 */
export function ThreadWorktreeActions({ threadId, onChanged }: { threadId: string; onChanged?: () => Promise<void> }) {
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
			await Promise.all([refresh(), onChanged?.()])
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
		<div data-testid="worktree-actions">
			{actions.map(([action, label, icon]) => (
				<button
					className={cn(MENU_ROW_CLASS, action === "remove" && confirmRemove && "text-error")}
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
					className={MENU_ROW_CLASS}
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
		</div>
	)
}
