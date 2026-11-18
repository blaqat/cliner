import type { AutomationRun, AutomationRunThread } from "@shared/automations"
import type { WorktreeSummary } from "@shared/thread-worktrees"
import { useEffect, useState } from "react"
import { LinkButton } from "@/components/common/LinkButton"
import { worktreeStatusText } from "@/components/worktrees/ThreadWorktreeActions"
import { threadWorktreeAction } from "@/components/worktrees/useWorktree"

interface ReadyForReviewProps {
	run: AutomationRun
	onOpenThread: (threadId: string) => void
	onWalkThrough: (threadId: string) => void
}

type Finished = AutomationRunThread & { threadId: string; picked: boolean }

/** Threads that replied, in step order, marking the one an Ask you step picked. */
export function finishedThreads(run: AutomationRun): Finished[] {
	const picked = new Set(run.steps.flatMap((step) => (step.kind === "checkpoint" && step.choice ? [step.choice] : [])))
	return run.steps.flatMap((step) =>
		step.threads
			.filter(
				(thread): thread is AutomationRunThread & { threadId: string } => !!thread.threadId && thread.status === "done",
			)
			.map((thread) => ({ ...thread, picked: step.kind === "together" && picked.has(thread.title) })),
	)
}

/** Where each worktree thread's changes stand; threads without changes drop out. */
function useWorktreeChanges(threads: readonly Finished[]): Map<string, WorktreeSummary> {
	const [changes, setChanges] = useState(new Map<string, WorktreeSummary>())
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
 * What a finished run made, right where it ran: worktrees with changes (Walk through opens that thread's
 * walkthrough) and every thread that replied (Read opens it). Notes and code stay where they are; this
 * only points at them.
 */
export function ReadyForReview({ run, onOpenThread, onWalkThrough }: ReadyForReviewProps) {
	const threads = finishedThreads(run)
	const changes = useWorktreeChanges(threads)
	if (threads.length === 0) return null
	const withChanges = threads.filter((thread) => changes.has(thread.threadId))
	return (
		<div
			className="mt-1.5 rounded-xs border border-link/30 bg-link/10 px-2 py-1.5"
			data-testid={`ready-for-review-${run.id}`}>
			<div className="mb-0.5 flex items-center gap-1.5 font-semibold">
				<span aria-hidden className="codicon codicon-checklist text-[12px]!" />
				Ready for review
			</div>
			{withChanges.map((thread) => (
				<div
					className="flex min-w-0 items-center gap-1.5 py-0.5"
					data-testid={`review-code-${thread.id}`}
					key={`code-${thread.id}`}>
					<span aria-hidden className="codicon codicon-git-branch shrink-0 text-[12px]! text-description" />
					<span className="min-w-0 shrink truncate">Code · {thread.title}</span>
					<span className="min-w-0 flex-1 truncate text-description">
						{worktreeStatusText(changes.get(thread.threadId) as WorktreeSummary)}
					</span>
					<LinkButton className="shrink-0" onClick={() => onWalkThrough(thread.threadId)}>
						Walk through
					</LinkButton>
				</div>
			))}
			{threads.map((thread) => (
				<div
					className="flex min-w-0 items-center gap-1.5 py-0.5"
					data-testid={`review-thread-${thread.id}`}
					key={thread.id}>
					<span aria-hidden className="codicon codicon-comment shrink-0 text-[12px]! text-description" />
					<span className="min-w-0 shrink truncate">{thread.title}</span>
					{thread.picked && <span className="shrink-0 text-description">· you picked it</span>}
					<span className="min-w-0 flex-1 truncate text-description" title={thread.reply}>
						{thread.reply}
					</span>
					<LinkButton className="shrink-0" onClick={() => onOpenThread(thread.threadId)}>
						Read
					</LinkButton>
				</div>
			))}
		</div>
	)
}
