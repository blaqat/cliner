import type { AutomationRun, AutomationRunThread } from "@shared/automations"
import type { WorktreeSummary } from "@shared/thread-worktrees"
import { useEffect, useState } from "react"
import { LinkButton } from "@/components/common/LinkButton"
import { worktreeStatusText } from "@/components/worktrees/ThreadWorktreeActions"
import { threadWorktreeAction } from "@/components/worktrees/useWorktree"

interface ReadyForReviewProps {
	run: AutomationRun
	onWalkThrough: (threadId: string) => void
	/** Notes each thread wrote (slugs), from the task page. */
	notesWritten?: ReadonlyMap<string, readonly string[]>
	noteNames?: ReadonlyMap<string, string>
	onOpenNote?: (slug: string) => void
}

type Finished = AutomationRunThread & { threadId: string }

/** Threads that replied, in step order. */
export function finishedThreads(run: AutomationRun): Finished[] {
	return run.steps.flatMap((step) =>
		step.threads.filter(
			(thread): thread is AutomationRunThread & { threadId: string } => !!thread.threadId && thread.status === "done",
		),
	)
}

/** Where each worktree thread's changes stand; threads without changes drop out. */
function useWorktreeChanges(threads: readonly Finished[]): Map<string, WorktreeSummary> | undefined {
	const [changes, setChanges] = useState<Map<string, WorktreeSummary>>()
	const key = threads
		.filter((thread) => thread.worktree)
		.map((thread) => thread.threadId)
		.join(",")
	useEffect(() => {
		let cancelled = false
		const ids = key ? key.split(",") : []
		void Promise.all(
			ids.map(async (id) => {
				try {
					return [id, (await threadWorktreeAction("summary", id)).summary] as const
				} catch {
					return [id, undefined] as const
				}
			}),
		).then((entries) => {
			if (cancelled) return
			setChanges(
				new Map(
					entries.filter(
						(entry): entry is readonly [string, WorktreeSummary] =>
							!!entry[1] && (entry[1].changedFiles > 0 || entry[1].commits > 0),
					),
				),
			)
		})
		return () => {
			cancelled = true
		}
	}, [key])
	return changes
}

/**
 * What a finished run left for you to look at: code its worktree threads changed (Walk through opens that
 * thread's walkthrough) and notes its threads wrote. Replies stay with their steps above; this only
 * points at what needs a review. Says so when there's nothing to review.
 */
export function ReadyForReview({ run, onWalkThrough, notesWritten, noteNames, onOpenNote }: ReadyForReviewProps) {
	const threads = finishedThreads(run)
	const changes = useWorktreeChanges(threads)
	const taskWorktrees = new Set<string>()
	const withChanges = threads.filter((thread) => {
		const summary = changes?.get(thread.threadId)
		if (!summary) return false
		if (summary.taskGroupId) {
			if (taskWorktrees.has(summary.taskGroupId)) return false
			taskWorktrees.add(summary.taskGroupId)
		}
		return true
	})
	const notes = [...new Set(threads.flatMap((thread) => notesWritten?.get(thread.threadId) ?? []))]
	// Wait for the worktrees before saying there's nothing.
	const nothing = !!changes && withChanges.length === 0 && notes.length === 0
	return (
		<div
			className="mt-1.5 rounded-xs border border-link/30 bg-link/10 px-2 py-1.5"
			data-testid={`ready-for-review-${run.id}`}>
			<div className="flex items-center gap-1.5 font-semibold">
				<span aria-hidden className="codicon codicon-checklist text-[12px]!" />
				Ready for review
			</div>
			{nothing && (
				<div className="mt-0.5 text-description" data-testid={`review-nothing-${run.id}`}>
					No code or notes changed. Each step's reply is in its step above.
				</div>
			)}
			{withChanges.map((thread) => (
				<div className="py-0.5" data-testid={`review-code-${thread.id}`} key={thread.id}>
					<div className="flex min-w-0 items-center gap-1.5">
						<span aria-hidden className="codicon codicon-git-branch shrink-0 text-[12px]! text-description" />
						<span className="min-w-0 flex-1 truncate">
							{changes?.get(thread.threadId)?.taskGroupId ? "Task worktree" : thread.title}
						</span>
						<LinkButton className="shrink-0" onClick={() => onWalkThrough(thread.threadId)}>
							Walk through
						</LinkButton>
					</div>
					<div className="pl-4.5 text-description">
						{worktreeStatusText(changes?.get(thread.threadId) as WorktreeSummary)}
					</div>
				</div>
			))}
			{notes.map((slug) => (
				<div className="flex min-w-0 items-center gap-1.5 py-0.5" data-testid={`review-note-${slug}`} key={slug}>
					<span aria-hidden className="codicon codicon-book shrink-0 text-[12px]! text-description" />
					<span className="min-w-0 flex-1 truncate">{noteNames?.get(slug) ?? slug}</span>
					{onOpenNote && (
						<LinkButton className="shrink-0" onClick={() => onOpenNote(slug)}>
							Open note
						</LinkButton>
					)}
				</div>
			))}
		</div>
	)
}
