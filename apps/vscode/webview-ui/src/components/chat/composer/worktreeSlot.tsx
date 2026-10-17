import { useWorktree } from "@/components/worktrees/useWorktree"
import { WorktreeToggle } from "@/components/worktrees/WorktreeToggle"
import { MENU_HEADING_CLASS } from "./menuKeyboard"

/**
 * The where pill's worktree parts (PLAN step 8):
 * - `WorktreeToggleSlot`: the "Workspace" section of the pill's menu. A new thread gets the
 *   "Run in worktree" toggle; an existing one only shows where it runs (isolation is picked at start).
 * - `WorktreeBadgeSlot`: " · ⑂" on the pill when the thread (or the next new one) runs in a worktree.
 * Both render nothing while worktrees are off.
 */
export const WorktreeToggleSlot = ({ threadId }: { threadId?: string }) => {
	const { availability, state } = useWorktree(threadId)
	if (!availability || availability.mode === "off") return null
	const mapping = state?.mapping
	return (
		<div className="border-t border-menu-foreground/10 px-1 pt-1 pb-1.5" data-testid="where-workspace">
			<div className={MENU_HEADING_CLASS}>Workspace</div>
			<div className="px-2 pt-1">
				{!threadId ? (
					<WorktreeToggle />
				) : mapping ? (
					<span className="text-xs">
						<span aria-hidden>⑂ </span>
						Worktree · <code className="text-[11px]">{mapping.branch}</code>
					</span>
				) : (
					<span className="text-xs text-description">Your workspace</span>
				)}
			</div>
		</div>
	)
}

export const WorktreeBadgeSlot = ({ threadId }: { threadId?: string }) => {
	const { enabled } = useWorktree(threadId)
	if (!enabled) return null
	return (
		<span aria-label="runs in a worktree" className="shrink-0 text-description">
			{" · ⑂"}
		</span>
	)
}
