import { MENU_ICON_CLASS, MENU_ITEM_CLASS } from "@/components/common/menuStyles"
import { cn } from "@/lib/utils"
import { useWorktree } from "./useWorktree"

/** The where pill's "Run in worktree" row: a checkable menu item, like the task rows above it. */
export function WorktreeToggle() {
	const { enabled, availability, setEnabled, error, busy } = useWorktree()
	return (
		<div>
			<button
				aria-checked={enabled}
				className={MENU_ITEM_CLASS}
				disabled={busy || (!enabled && !availability?.available)}
				onClick={() => void setEnabled(!enabled)}
				role="menuitemcheckbox"
				title={availability?.reason}
				type="button">
				<span aria-hidden className={cn(MENU_ICON_CLASS, "codicon-repo-forked text-description")} />
				<span className="min-w-0 flex-1 truncate">Run in worktree</span>
				{availability?.mode === "mm" && <span className="shrink-0 text-[11px] text-description">mm</span>}
				<span aria-hidden className={cn(MENU_ICON_CLASS, "codicon-check", !enabled && "invisible")} />
			</button>
			{(error || availability?.reason) && (
				<p className="m-0 px-2 pt-0.5 text-[11px] text-description" role={error ? "alert" : undefined}>
					{error || availability?.reason}
				</p>
			)}
		</div>
	)
}
