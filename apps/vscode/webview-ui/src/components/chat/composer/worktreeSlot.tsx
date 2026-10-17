import { MENU_HEADING_CLASS, MENU_ICON_CLASS, MENU_SEPARATOR_CLASS } from "@/components/common/menuStyles"
import { useWorktree } from "@/components/worktrees/useWorktree"
import { WorktreeToggle } from "@/components/worktrees/WorktreeToggle"
import { cn } from "@/lib/utils"

/**
 * The where pill's worktree parts (PLAN step 8):
 * - `WorktreeToggleSlot`: the "Workspace" section of the pill's menu. A new thread gets the
 *   "Run in worktree" toggle; an existing one only shows where it runs (isolation is picked at start).
 * - `WorktreeBadgeSlot`: a forked-repo codicon on the pill when the thread (or the next new one) runs
 *   in a worktree.
 * Both render nothing while worktrees are off.
 */
export const WorktreeToggleSlot = ({ threadId }: { threadId?: string }) => {
	const { availability, state } = useWorktree(threadId)
	if (!availability || availability.mode === "off") return null
	const mapping = state?.mapping
	return (
		<div data-testid="where-workspace">
			<div className={MENU_SEPARATOR_CLASS} />
			<div className={MENU_HEADING_CLASS}>Workspace</div>
			{!threadId ? (
				<WorktreeToggle />
			) : (
				<div className="flex h-6 min-w-0 items-center gap-1.5 px-2 text-[12px]">
					<span
						aria-hidden
						className={cn(MENU_ICON_CLASS, mapping ? "codicon-repo-forked" : "codicon-folder", "text-description")}
					/>
					{mapping ? (
						<span className="min-w-0 truncate">
							Worktree · <code className="ph-no-capture text-[11px]">{mapping.branch}</code>
						</span>
					) : (
						<span className="text-description">Your workspace</span>
					)}
				</div>
			)}
		</div>
	)
}

export const WorktreeBadgeSlot = ({ threadId }: { threadId?: string }) => {
	const { enabled } = useWorktree(threadId)
	if (!enabled) return null
	return (
		<span
			aria-label="runs in a worktree"
			className="codicon codicon-repo-forked shrink-0 text-[11px]! text-description"
			role="img"
		/>
	)
}
