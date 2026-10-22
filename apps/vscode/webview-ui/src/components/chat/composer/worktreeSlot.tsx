import { useState } from "react"
import {
	COMPOSER_ICON_BUTTON_CLASS,
	COMPOSER_ICON_BUTTON_OPEN_CLASS,
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

/**
 * The composer's workspace button, left of the where pill: where the thread runs (your workspace
 * or its own git/mm worktree). A new thread picks here; an existing one shows where it runs, since
 * isolation is chosen at start. Whenever a worktree can't be used (off, mm not set up, no git
 * history), the menu says why and links to Settings › Worktrees, so the user is never stuck.
 */
export function WorkspaceButton() {
	const { currentTaskItem, navigateToSettings } = useExtensionState()
	const threadId = currentTaskItem?.id
	const { availability, state, enabled, setEnabled, error, refresh } = useWorktree(threadId)
	const [open, setOpen] = useState(false)
	// Subagent threads run where their parent does.
	if (currentTaskItem?.isSubagent) return null

	const mapping = state?.mapping
	const off = !availability || availability.mode === "off"
	const canUse = !off && !!availability?.available
	const mm = availability?.mode === "mm"
	const label = mapping
		? `Workspace: worktree ${mapping.branch}`
		: enabled
			? "Workspace: a new worktree for this thread"
			: "Workspace: your workspace"
	// Why a worktree isn't offered right now; empty when it is.
	const blocker = error || (off ? "Worktrees are off." : availability?.available ? "" : (availability?.reason ?? ""))

	const openSettings = () => {
		setOpen(false)
		navigateToSettings("worktrees")
	}
	const pick = (worktree: boolean) => {
		void setEnabled(worktree)
		setOpen(false)
	}

	return (
		<Popover onOpenChange={setOpen} open={open}>
			<PopoverTrigger asChild>
				<button
					aria-label={label}
					className={cn(
						COMPOSER_ICON_BUTTON_CLASS,
						open && COMPOSER_ICON_BUTTON_OPEN_CLASS,
						enabled && "text-(--vscode-charts-green)",
					)}
					data-testid="workspace-button"
					data-worktree={enabled ? "true" : undefined}
					title={label}
					type="button">
					<span aria-hidden className={`codicon codicon-${enabled ? "repo-forked" : "folder"} text-[13px]!`} />
				</button>
			</PopoverTrigger>
			<PopoverContent
				align="start"
				className={cn("menu-rise w-64 p-1", COMPOSER_MENU_SCROLL_CLASS)}
				data-testid="workspace-menu"
				onKeyDown={handleMenuKeyDown}
				side="top">
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
				) : (
					<div className="flex h-6 min-w-0 items-center gap-1.5 px-2 text-[12px]" data-testid="workspace-current">
						<span
							aria-hidden
							className={cn(
								MENU_ICON_CLASS,
								mapping ? "codicon-repo-forked" : "codicon-folder",
								"text-description",
							)}
						/>
						{mapping ? (
							<span className="min-w-0 truncate">
								Worktree · <code className="ph-no-capture text-[11px]">{mapping.branch}</code>
							</span>
						) : (
							<span className="min-w-0 truncate">Your workspace</span>
						)}
					</div>
				)}
				{threadId && mapping && <ThreadWorktreeActions onChanged={refresh} threadId={threadId} />}
				{threadId && !mapping && (
					<p className="m-0 px-2 pb-0.5 text-[11px] text-description">A thread's workspace is picked when it starts.</p>
				)}
				{blocker && (
					<p
						className="m-0 px-2 pt-0.5 text-[11px] text-description"
						data-testid="workspace-blocker"
						role={error ? "alert" : undefined}>
						{blocker}
					</p>
				)}
				<div className={MENU_SEPARATOR_CLASS} />
				<button
					className={cn(MENU_ROW_CLASS, "text-link")}
					data-testid="workspace-settings"
					onClick={openSettings}
					role="menuitem"
					type="button">
					<span aria-hidden className={cn(MENU_ICON_CLASS, "codicon-gear")} />
					<span className="min-w-0 flex-1 truncate">
						{off
							? "Turn on in Settings"
							: blocker
								? mm
									? "Set up mm in Settings"
									: "Fix in Settings"
								: "Worktree settings"}
					</span>
					<span aria-hidden className={cn(MENU_ICON_CLASS, "codicon-chevron-right")} />
				</button>
			</PopoverContent>
		</Popover>
	)
}
