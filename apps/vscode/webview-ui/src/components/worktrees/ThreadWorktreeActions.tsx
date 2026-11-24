import type { ThreadWorktree, WorktreeSummary } from "@shared/thread-worktrees"
import { useCallback, useEffect, useRef, useState } from "react"
import { MENU_ROW_CLASS } from "@/components/chat/composer/menuKeyboard"
import { MENU_ICON_CLASS, MENU_SEPARATOR_CLASS } from "@/components/common/menuStyles"
import { WarningText } from "@/components/common/WarningText"
import { cn } from "@/lib/utils"
import { threadWorktreeAction } from "./useWorktree"

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`

/** "2 files changed · 1 commit · not copied here": where the thread's changes stand. */
export function worktreeStatusText(summary: WorktreeSummary): string {
	if (summary.takenOver) return "Your workspace is on this branch now"
	if (summary.changedFiles === 0 && summary.commits === 0)
		// Staged versions differ from what's on disk: Remove would still discard them.
		return summary.loseOnRemove > 0 ? "Staged changes not copied here" : "No changes yet"
	const copy =
		summary.uncopiedFiles === 0
			? "copied here"
			: summary.copied
				? `${summary.uncopiedFiles} not copied yet`
				: "not copied here"
	return [
		`${plural(summary.changedFiles, "file")} changed`,
		summary.commits > 0 ? plural(summary.commits, "commit") : undefined,
		copy,
	]
		.filter(Boolean)
		.join(" · ")
}

type Action = "open" | "bring" | "undo" | "takeOver" | "remove"

/** An action's outcome, shown in place of the status line (so the menu never grows a notice). */
interface Outcome {
	tone: "ok" | "warning"
	text: string
	/** Offer Undo right on the line (after a copy). */
	undo?: boolean
	/** Offer the Source Control view (the workspace's own changes are in the way). */
	sourceControl?: boolean
	/** Offer to read the worktree again (its status couldn't be read). */
	retry?: boolean
}

const BUSY_TEXT: Partial<Record<Action, string>> = {
	bring: "Copying…",
	undo: "Undoing the copy…",
	takeOver: "Switching your workspace…",
	remove: "Removing…",
}

const LINK_CLASS = "cursor-pointer border-0 bg-transparent p-0 text-[11px] text-link hover:underline"
const HINT_CLASS = "-mt-0.5 truncate pr-2 pb-0.5 pl-7 text-[10.5px] text-description"

/**
 * The workspace menu for a thread that runs in its own worktree: the branch, one status line that
 * says where the thread's changes stand, then only the actions that apply. An action's result
 * replaces the status line rather than adding a notice, and Remove asks in place on its own row,
 * so the menu never shifts. Anything blocked says why and links to the fix.
 */
export function ThreadWorktreeActions({
	threadId,
	mapping,
	onChanged,
	onClose,
	onRemoved,
	refreshKey,
}: {
	threadId: string
	mapping: ThreadWorktree
	/** Refreshes the caller's worktree state, so the button follows a removal. */
	onChanged?: () => Promise<void>
	/** Closes the menu (before showing Source Control). */
	onClose?: () => void
	onRemoved?: (message: string) => void
	refreshKey?: string
}) {
	const [summary, setSummary] = useState<WorktreeSummary>()
	const [outcome, setOutcome] = useState<Outcome>()
	const [busy, setBusy] = useState<Action>()
	const [removeWarning, setRemoveWarning] = useState<{ text: string; confirmation?: string }>()

	// The status couldn't be read (say, the folder is gone): Remove still works, so the thread is never stuck with it.
	const [summaryFailed, setSummaryFailed] = useState(false)
	const taskGroupId = mapping.taskGroupId
	const waitText = taskGroupId ? "Wait for every thread using this worktree to finish" : "Wait for the thread to finish"

	const refresh = useCallback(async () => {
		try {
			setSummary((await threadWorktreeAction("summary", threadId, undefined, false, taskGroupId)).summary)
			setSummaryFailed(false)
		} catch (error) {
			setSummaryFailed(true)
			setOutcome({ tone: "warning", text: `Couldn't read this worktree: ${errorText(error)}`, retry: true })
		}
	}, [threadId, taskGroupId])
	// biome-ignore lint/correctness/useExhaustiveDependencies: Refresh when member activity changes.
	useEffect(() => {
		void refresh()
	}, [refresh, refreshKey])
	// Edits made outside a thread's run (by hand, in an editor, by another window) change no thread's
	// status, so read the worktree again when the user comes back to this view. The caller's state too:
	// another window may have removed or replaced the worktree.
	const changed = useRef(onChanged)
	changed.current = onChanged
	useEffect(() => {
		const onFocus = () => {
			void refresh()
			void changed.current?.()
		}
		const onVisible = () => document.visibilityState === "visible" && onFocus()
		window.addEventListener("focus", onFocus)
		document.addEventListener("visibilitychange", onVisible)
		return () => {
			window.removeEventListener("focus", onFocus)
			document.removeEventListener("visibilitychange", onVisible)
		}
	}, [refresh])
	useEffect(() => {
		if (!taskGroupId || !summary?.running) return
		const timer = setInterval(() => void refresh(), 1500)
		return () => clearInterval(timer)
	}, [refresh, summary?.running, taskGroupId])

	const act = async (action: Action, confirmed = false) => {
		setBusy(action)
		setRemoveWarning(undefined)
		try {
			const result = await threadWorktreeAction(
				action,
				threadId,
				undefined,
				confirmed,
				taskGroupId,
				confirmed ? removeWarning?.confirmation : undefined,
			)
			if (action === "remove" && result.warning) {
				// Something would be lost after all: ask on the row.
				setRemoveWarning({ text: result.warning, confirmation: result.removalConfirmation })
				return
			}
			if (result.warning) {
				setOutcome({
					tone: "warning",
					text: result.warning,
					sourceControl: action === "takeOver" && !result.mapping,
					undo: action === "bring" && !!result.files,
				})
			} else if (action !== "open") {
				const text = result.message ?? ""
				setOutcome(
					result.conflicts?.length
						? { tone: "warning", text: `${text} ${result.conflicts.join(", ")}` }
						: { tone: "ok", text, undo: action === "bring" && !!result.files },
				)
			}
			// A removed worktree has nothing left to summarize; the caller's menu goes back to "Your workspace".
			const removed = action === "remove" && !result.warning
			if (removed) onRemoved?.(result.message ?? "Worktree removed.")
			await Promise.all([removed ? undefined : refresh(), onChanged?.()])
		} catch (error) {
			// A copy that clashes with the workspace's own edits: those are what to look at.
			setOutcome({ tone: "warning", text: errorText(error), sourceControl: action === "bring" })
		} finally {
			setBusy(undefined)
		}
	}

	const showSourceControl = () => {
		onClose?.()
		void threadWorktreeAction("sourceControl", threadId).catch(() => {})
	}

	const running = !!summary?.running
	const takenOver = !!summary?.takenOver
	const disabled = !!busy || !summary
	const statusTone = busy ? undefined : outcome ? outcome.tone : takenOver ? "ok" : undefined
	const statusText = busy
		? (BUSY_TEXT[busy] ?? "Working…")
		: outcome
			? outcome.text
			: summary
				? worktreeStatusText(summary)
				: "Checking changes…"
	const switchBlocker = summary?.workspaceDirty ? (summary.canUndo ? "undo" : "workspace") : running ? "running" : undefined

	return (
		<div data-testid="worktree-actions">
			<div className="flex h-6 min-w-0 items-center gap-1.5 px-2 text-[12px]" data-testid="workspace-current">
				<span aria-hidden className={cn(MENU_ICON_CLASS, "codicon-repo-forked text-(--vscode-charts-green)")} />
				<code className="ph-no-capture min-w-0 truncate text-[11px]" title={mapping.branch}>
					{mapping.branch}
				</code>
			</div>
			<div
				aria-live="polite"
				className={cn(
					"flex min-h-5 min-w-0 items-center gap-1 pr-2 pl-7 text-[11px]",
					// Warnings stay readable (yellow text washes out on light themes); the icon carries the tone.
					statusTone === "ok" ? "text-success" : statusTone === "warning" ? "text-menu-foreground" : "text-description",
				)}
				data-testid="worktree-status"
				data-tone={statusTone}
				role="status">
				{statusTone === "ok" && <span aria-hidden className="codicon codicon-check shrink-0 text-[11px]!" />}
				{statusTone === "warning" && (
					<span aria-hidden className="codicon codicon-warning shrink-0 self-start pt-0.5 text-[11px]! text-warning" />
				)}
				<span className={cn("min-w-0 wrap-anywhere", statusTone !== "warning" && "line-clamp-2")} title={statusText}>
					{statusText}
				</span>
				{!busy && outcome?.undo && summary?.canUndo && (
					<>
						<span aria-hidden>·</span>
						<button className={LINK_CLASS} onClick={() => void act("undo")} type="button">
							Undo
						</button>
					</>
				)}
				{!busy && outcome?.retry && (
					<>
						<span aria-hidden>·</span>
						<button
							className={cn(LINK_CLASS, "shrink-0")}
							onClick={() => {
								setOutcome(undefined)
								void refresh()
							}}
							type="button">
							Try again
						</button>
					</>
				)}
				{!busy && outcome?.sourceControl && (
					<>
						<span aria-hidden>·</span>
						<button className={cn(LINK_CLASS, "shrink-0")} onClick={showSourceControl} type="button">
							Source Control
						</button>
					</>
				)}
			</div>
			<div className={MENU_SEPARATOR_CLASS} />
			{taskGroupId && summary?.settled && (
				<p className="m-0 px-2 py-1 text-[11px] text-description">
					All threads using this worktree are settled. You can remove it below.
				</p>
			)}
			{/* Still offered after Take over: submodule changes Take over couldn't move stay in the leftover folder. */}
			<button className={MENU_ROW_CLASS} disabled={!!busy} onClick={() => void act("open")} role="menuitem" type="button">
				<span aria-hidden className={cn(MENU_ICON_CLASS, "codicon-empty-window")} />
				<span className="min-w-0 flex-1 truncate">{takenOver ? "Open the leftover worktree" : "Open in new window"}</span>
			</button>
			{!takenOver && !!summary?.uncopiedFiles && (
				<button
					className={MENU_ROW_CLASS}
					disabled={disabled || running}
					onClick={() => void act("bring")}
					role="menuitem"
					title={running ? waitText : "Apply the worktree's changes to your workspace's files"}
					type="button">
					<span aria-hidden className={cn(MENU_ICON_CLASS, "codicon-arrow-down")} />
					<span className="min-w-0 flex-1 truncate">Copy changes here</span>
					<span className="shrink-0 text-[11px] text-description">{plural(summary.uncopiedFiles, "file")}</span>
				</button>
			)}
			{!takenOver && summary?.canUndo && (
				<button
					className={MENU_ROW_CLASS}
					disabled={disabled || running}
					onClick={() => void act("undo")}
					role="menuitem"
					type="button">
					<span aria-hidden className={cn(MENU_ICON_CLASS, "codicon-discard")} />
					<span className="min-w-0 flex-1 truncate">Undo the copy</span>
				</button>
			)}
			{!takenOver && (
				<>
					<button
						className={MENU_ROW_CLASS}
						disabled={disabled || !!switchBlocker}
						onClick={() => void act("takeOver")}
						role="menuitem"
						title="Check out this branch in your workspace and continue there"
						type="button">
						<span aria-hidden className={cn(MENU_ICON_CLASS, "codicon-git-branch")} />
						<span className="min-w-0 flex-1 truncate">Switch workspace to this branch</span>
					</button>
					{switchBlocker && (
						<div className={cn(HINT_CLASS, "whitespace-normal wrap-anywhere")} data-testid="worktree-switch-hint">
							{switchBlocker === "undo" ? (
								"Undo the copy (or commit it) first"
							) : switchBlocker === "running" ? (
								waitText
							) : (
								<>
									{summary?.workspaceChanges?.length
										? `Commit or stash your workspace's changes first (${summary.workspaceChanges.slice(0, 3).join(", ")}${summary.workspaceChanges.length > 3 ? " and more" : ""})`
										: "Commit or stash your workspace's changes first"}{" "}
									·{" "}
									<button className={LINK_CLASS} onClick={showSourceControl} type="button">
										Source Control
									</button>
								</>
							)}
						</div>
					)}
				</>
			)}
			{removeWarning ? (
				<div
					className="mx-1 my-0.5 flex min-w-0 flex-col gap-1.5 rounded-xs border border-solid border-error/40 bg-error/10 px-2 py-1.5 text-[11.5px]"
					data-testid="worktree-remove-confirm"
					role="group">
					<div className="flex min-w-0 items-start gap-1.5">
						<span aria-hidden className="codicon codicon-warning mt-px shrink-0 text-[12px]! text-error" />
						<WarningText className="flex-1" text={removeWarning.text} />
					</div>
					<div className="flex items-center gap-1.5 pl-[18px]">
						<button
							className="h-5 shrink-0 cursor-pointer rounded-xs border-0 bg-error px-2 text-[11px] text-background hover:bg-error/90"
							onClick={() => void act("remove", true)}
							type="button">
							Remove anyway
						</button>
						<button
							className="h-5 shrink-0 cursor-pointer rounded-xs border-0 bg-button-secondary-background px-2 text-[11px] text-button-secondary-foreground hover:bg-button-secondary-background-hover"
							onClick={() => setRemoveWarning(undefined)}
							type="button">
							Cancel
						</button>
					</div>
				</div>
			) : (
				<button
					className={MENU_ROW_CLASS}
					disabled={!!busy || (!summary && !summaryFailed) || running}
					onClick={() => void act("remove")}
					role="menuitem"
					title={running ? waitText : undefined}
					type="button">
					<span aria-hidden className={cn(MENU_ICON_CLASS, takenOver ? "codicon-trash" : "codicon-close")} />
					<span className="min-w-0 flex-1 truncate">
						{takenOver ? "Remove the leftover worktree folder" : "Remove worktree"}
					</span>
				</button>
			)}
		</div>
	)
}

/** gRPC errors arrive as "Error: git apply: …"; the menu only wants the sentence. */
function errorText(error: unknown): string {
	return String(error instanceof Error ? error.message : error).replace(/^(Error:\s*)+/, "")
}
