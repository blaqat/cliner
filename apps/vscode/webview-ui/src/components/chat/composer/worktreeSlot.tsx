import { useEffect, useState } from "react"
import { InlineNotice } from "@/components/common/InlineNotice"
import {
	COMPOSER_LINE_CHIP_CLASS,
	COMPOSER_MENU_SCROLL_CLASS,
	MENU_ICON_CLASS,
	MENU_SEPARATOR_CLASS,
} from "@/components/common/menuStyles"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { ThreadWorktreeActions } from "@/components/worktrees/ThreadWorktreeActions"
import {
	clearWorktreeStartFailure,
	threadWorktreeAction,
	useWorktree,
	useWorktreeStartFailure,
} from "@/components/worktrees/useWorktree"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { cn } from "@/lib/utils"
import { handleMenuKeyDown, MENU_HEADING_CLASS, MENU_ROW_CLASS } from "./menuKeyboard"

type WorktreeInfo = ReturnType<typeof useWorktree>

/**
 * The workspace menu: a new thread picks between your workspace and a new worktree; a worktree
 * thread gets its worktree actions. Whenever a worktree can't be used (off, off here, mm not set up,
 * no git history), it says which and links to the fix: the control in Settings › Worktrees that turns
 * it on, or Source Control for the folder's git.
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
	// Re-check on open: mm.js, git history or another window's settings may have changed since.
	// biome-ignore lint/correctness/useExhaustiveDependencies: once per open.
	useEffect(() => {
		void refresh(true)
	}, [])
	const mapping = threadId ? state?.mapping : undefined
	const canUse = !!availability?.available
	const mm = availability?.mode === "mm"
	const fix = availability?.available ? undefined : availability?.fix
	// Why a worktree isn't offered right now; empty when it is. Before the first check: nothing yet.
	const mmHint = fix === "mode" && state?.mmConfigFile ? ` This folder is an mm workspace (${state.mmConfigFile}).` : ""
	const blocker = error || (!availability || availability.available ? "" : (availability.reason ?? "") + mmHint)
	// Git problems are fixed in the folder; the rest in Settings, on the control that fixes them.
	const folderFix = fix === "repository" || fix === "commit"
	const pick = (value: boolean) => {
		void setEnabled(value)
		clearWorktreeStartFailure()
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
						{canUse && mm && <span className="shrink-0 text-[11px] text-description">mm</span>}
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
					className="m-0 line-clamp-none wrap-anywhere px-2 pt-0.5 text-[11px] text-description"
					data-testid="workspace-blocker"
					role={error ? "alert" : undefined}>
					{mapping ? error : blocker}
					{error && (
						<>
							{" "}
							<button
								className="cursor-pointer border-0 bg-transparent p-0 text-[11px] text-link hover:underline"
								onClick={() => void refresh(true)}
								type="button">
								Try again
							</button>
						</>
					)}
				</p>
			)}
			<div className={MENU_SEPARATOR_CLASS} />
			{!mapping && folderFix && (
				<button
					className={cn(MENU_ROW_CLASS, "text-link")}
					data-testid="workspace-folder-fix"
					onClick={() => {
						onClose()
						void threadWorktreeAction("openSourceControl")
					}}
					role="menuitem"
					type="button">
					<span aria-hidden className={cn(MENU_ICON_CLASS, "codicon-source-control")} />
					<span className="min-w-0 flex-1 truncate">Open Source Control</span>
				</button>
			)}
			<button
				className={cn(MENU_ROW_CLASS, !folderFix && "text-link")}
				data-testid="workspace-settings"
				onClick={() => {
					onClose()
					// Settings focuses the control that fixes what's in the way (see WorktreeSettings).
					navigateToSettings("worktrees")
				}}
				role="menuitem"
				type="button">
				<span aria-hidden className={cn(MENU_ICON_CLASS, "codicon-gear")} />
				<span className="min-w-0 flex-1 truncate">
					{mapping || !fix || folderFix
						? "Worktree settings"
						: fix === "mm"
							? "Fix in Settings"
							: "Turn on in Settings"}
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

const NOTICE_LINK_CLASS = "cursor-pointer border-0 bg-transparent p-0 text-[12px] text-link hover:underline"

/**
 * Above a new thread's "In … for …" line when it couldn't start because its worktree couldn't be
 * made: what happened, and the two ways on (fix it in Settings, or run in your workspace instead).
 * The message stays in the composer, so Send again is all it takes.
 */
export function WorktreeStartNotice() {
	const { navigateToSettings } = useExtensionState()
	const failure = useWorktreeStartFailure()
	const worktree = useWorktree()
	if (!failure) return null
	return (
		<InlineNotice
			actions={
				<button
					aria-label="Dismiss"
					className="flex size-5 cursor-pointer items-center justify-center rounded-xs border-0 bg-transparent p-0 text-description hover:bg-toolbar-hover hover:text-foreground"
					onClick={clearWorktreeStartFailure}
					title="Dismiss"
					type="button">
					<span aria-hidden className="codicon codicon-close text-[12px]" />
				</button>
			}
			className="mx-3 mb-1.5"
			data-testid="worktree-start-failure"
			tone="error">
			<span className="min-w-0 flex-1">
				<b className="font-semibold">Couldn't make a worktree for this thread.</b> {failure}{" "}
				<span className="whitespace-nowrap">
					<button
						className={NOTICE_LINK_CLASS}
						onClick={() => {
							clearWorktreeStartFailure()
							navigateToSettings("worktrees")
						}}
						type="button">
						Worktree settings
					</button>
					{worktree.enabled && (
						<>
							{" · "}
							<button
								className={NOTICE_LINK_CLASS}
								onClick={() => {
									void worktree.setEnabled(false)
									clearWorktreeStartFailure()
								}}
								title="Send again to start it in your workspace"
								type="button">
								Use your workspace instead
							</button>
						</>
					)}
				</span>
			</span>
		</InlineNotice>
	)
}
