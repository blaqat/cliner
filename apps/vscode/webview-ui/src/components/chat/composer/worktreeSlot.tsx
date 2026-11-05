import { useState } from "react"
import {
	COMPOSER_LINE_CHIP_CLASS,
	COMPOSER_MENU_SCROLL_CLASS,
	MENU_ICON_CLASS,
	MENU_SEPARATOR_CLASS,
} from "@/components/common/menuStyles"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { ThreadWorktreeActions } from "@/components/worktrees/ThreadWorktreeActions"
import { useWorktree } from "@/components/worktrees/useWorktree"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { cn } from "@/lib/utils"
import { handleMenuKeyDown, MENU_HEADING_CLASS, MENU_ROW_CLASS } from "./menuKeyboard"

type WorktreeInfo = ReturnType<typeof useWorktree>

/**
 * The workspace menu: a new thread picks between your workspace and a new worktree; a worktree
 * thread gets its worktree actions. Whenever a worktree can't be used (off, mm not set up, no git
 * history), it says why and links to Settings › Worktrees, so the user is never stuck.
 */
function WorkspaceMenuBody({
	threadId,
	worktree,
	onClose,
}: {
	threadId: string | undefined
	worktree: WorktreeInfo
	onClose: () => void
}) {
	const { navigateToSettings } = useExtensionState()
	const { availability, state, enabled, setEnabled, error, refresh } = worktree
	const mapping = threadId ? state?.mapping : undefined
	const off = !availability || availability.mode === "off"
	const canUse = !off && !!availability?.available
	const mm = availability?.mode === "mm"
	// Why a worktree isn't offered right now; empty when it is.
	const blocker = error || (off ? "Worktrees are off." : availability?.available ? "" : (availability?.reason ?? ""))
	const pick = (value: boolean) => {
		void setEnabled(value)
		onClose()
	}

	return (
		<>
			<div className={MENU_HEADING_CLASS}>Workspace</div>
			{!threadId ? (
				<div aria-label="Where the new thread runs" role="menu">
					<button
						aria-checked={!enabled}
						className={MENU_ROW_CLASS}
						onClick={() => pick(false)}
						role="menuitemradio"
						type="button">
						<span aria-hidden className={cn(MENU_ICON_CLASS, "codicon-folder text-description")} />
						<span className="min-w-0 flex-1 truncate">Your workspace</span>
						<span aria-hidden className={cn(MENU_ICON_CLASS, "codicon-check", enabled && "invisible")} />
					</button>
					<button
						aria-checked={enabled}
						className={MENU_ROW_CLASS}
						data-testid="workspace-worktree"
						disabled={!enabled && !canUse}
						onClick={() => pick(true)}
						role="menuitemradio"
						title={blocker || undefined}
						type="button">
						<span aria-hidden className={cn(MENU_ICON_CLASS, "codicon-repo-forked text-description")} />
						<span className="min-w-0 flex-1 truncate">New worktree</span>
						{mm && <span className="shrink-0 text-[11px] text-description">mm</span>}
						<span aria-hidden className={cn(MENU_ICON_CLASS, "codicon-check", !enabled && "invisible")} />
					</button>
				</div>
			) : mapping ? (
				<ThreadWorktreeActions mapping={mapping} onChanged={refresh} onClose={onClose} threadId={threadId} />
			) : (
				<>
					<div className="flex h-6 min-w-0 items-center gap-1.5 px-2 text-[12px]" data-testid="workspace-current">
						<span aria-hidden className={cn(MENU_ICON_CLASS, "codicon-folder text-description")} />
						<span className="min-w-0 truncate">Your workspace</span>
					</div>
					<p className="m-0 px-2 pb-0.5 text-[11px] text-description">A thread's workspace is picked when it starts.</p>
				</>
			)}
			{/* A worktree thread already has its worktree; only a failure to read it matters there. */}
			{(mapping ? error : blocker) && (
				<p
					className="m-0 px-2 pt-0.5 text-[11px] text-description"
					data-testid="workspace-blocker"
					role={error ? "alert" : undefined}>
					{mapping ? error : blocker}
				</p>
			)}
			<div className={MENU_SEPARATOR_CLASS} />
			<button
				className={cn(MENU_ROW_CLASS, "text-link")}
				data-testid="workspace-settings"
				onClick={() => {
					onClose()
					navigateToSettings("worktrees")
				}}
				role="menuitem"
				type="button">
				<span aria-hidden className={cn(MENU_ICON_CLASS, "codicon-gear")} />
				<span className="min-w-0 flex-1 truncate">
					{mapping
						? "Worktree settings"
						: off
							? "Turn on in Settings"
							: blocker
								? mm
									? "Set up mm in Settings"
									: "Fix in Settings"
								: "Worktree settings"}
				</span>
				<span aria-hidden className={cn(MENU_ICON_CLASS, "codicon-chevron-right")} />
			</button>
		</>
	)
}

/**
 * "In [Your workspace ⌄]" in the line under a new thread's composer: where the thread will run
 * (your workspace or its own git/mm worktree). Inside a thread it isn't shown; the thread header's
 * branch chip takes over for a worktree thread.
 */
export function WorkspaceButton() {
	const { currentTaskItem } = useExtensionState()
	const threadId = currentTaskItem?.id
	const worktree = useWorktree(threadId)
	const [open, setOpen] = useState(false)
	// Subagent threads run where their parent does.
	if (currentTaskItem?.isSubagent) return null

	// A new thread has no worktree of its own yet; inside a thread the header's branch chip shows it.
	const mapping = threadId ? worktree.state?.mapping : undefined
	const enabled = worktree.enabled
	const text = mapping ? mapping.branch : enabled ? "New worktree" : "Your workspace"
	const label = mapping
		? `Workspace: worktree ${mapping.branch}`
		: enabled
			? "Workspace: a new worktree for this thread"
			: "Workspace: your workspace"

	return (
		<Popover onOpenChange={setOpen} open={open}>
			<PopoverTrigger asChild>
				<button
					aria-label={label}
					className={COMPOSER_LINE_CHIP_CLASS}
					data-testid="workspace-button"
					data-worktree={enabled ? "true" : undefined}
					title={label}
					type="button">
					<span
						aria-hidden
						className={cn(
							"codicon shrink-0 text-[12px]!",
							enabled ? "codicon-repo-forked text-(--vscode-charts-green)" : "codicon-folder",
						)}
					/>
					<span className={cn("min-w-0 truncate", mapping && "font-mono")}>{text}</span>
					<span aria-hidden className="codicon codicon-chevron-down shrink-0 text-[10px]! opacity-70" />
				</button>
			</PopoverTrigger>
			<PopoverContent
				align="start"
				className={cn("menu-rise p-1", mapping ? "w-72" : "w-64", COMPOSER_MENU_SCROLL_CLASS)}
				data-testid="workspace-menu"
				onKeyDown={handleMenuKeyDown}
				side="top">
				<WorkspaceMenuBody onClose={() => setOpen(false)} threadId={threadId} worktree={worktree} />
			</PopoverContent>
		</Popover>
	)
}

/**
 * The thread header's branch chip: shown only when the thread runs in its own worktree, with the
 * branch in mono and the green worktree icon. Opens the same worktree menu (status, copy back,
 * switch, remove).
 */
export function ThreadBranchChip() {
	const { currentTaskItem } = useExtensionState()
	const threadId = currentTaskItem?.id
	const worktree = useWorktree(threadId)
	const [open, setOpen] = useState(false)
	const mapping = worktree.state?.mapping
	if (!threadId || currentTaskItem?.isSubagent || !mapping) return null

	return (
		<Popover onOpenChange={setOpen} open={open}>
			<PopoverTrigger asChild>
				<button
					aria-label={`Worktree: ${mapping.branch}`}
					className={cn(COMPOSER_LINE_CHIP_CLASS, "max-w-40 shrink")}
					data-testid="thread-branch-chip"
					title={`This thread runs in its own worktree on ${mapping.branch}`}
					type="button">
					<span aria-hidden className="codicon codicon-git-branch shrink-0 text-[12px]! text-(--vscode-charts-green)" />
					<span className="ph-no-capture min-w-0 truncate font-mono">{mapping.branch}</span>
				</button>
			</PopoverTrigger>
			<PopoverContent
				align="end"
				className={cn("menu-rise w-72 p-1", COMPOSER_MENU_SCROLL_CLASS)}
				data-testid="workspace-menu"
				onKeyDown={handleMenuKeyDown}
				side="bottom">
				<WorkspaceMenuBody onClose={() => setOpen(false)} threadId={threadId} worktree={worktree} />
			</PopoverContent>
		</Popover>
	)
}
