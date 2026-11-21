import { type AutomationRun, isLiveRun } from "@shared/automations"
import { useState } from "react"
import { LinkButton } from "@/components/common/LinkButton"
import { openTask } from "@/components/inbox/sessionActions"
import { useNavigationHistory } from "@/components/navigation/NavigationHistoryContext"
import { useAutomationRuns } from "@/hooks/useAutomationRuns"
import { cn } from "@/lib/utils"
import { StepStatusIcon } from "./RunBlock"
import { FixLink, ProblemList, stopRun, useRunActions } from "./runActions"
import { currentStep, runFailure, runForThread, runFraction, runNeeds } from "./runFacts"

interface AutomationRunBarProps {
	/** The thread on screen, if any. */
	threadId?: string
	/** The task on screen (the thread's task). */
	taskGroupId?: string
	onOpenTaskGroup?: (taskGroupId: string) => void
}

/** Failed runs the user closed the bar for (this session). */
const dismissed = new Set<string>()

/** A finished run stays in the bar this long, pointing at Ready for review. */
const DONE_SHOWN_MS = 30 * 60_000

/** The run this bar is about: a live one here, else one that just ended here (failed, or done to review). */
function pickRun(
	runs: readonly AutomationRun[],
	threadId: string | undefined,
	taskGroupId: string | undefined,
	now: number,
): AutomationRun | undefined {
	const own = runForThread(runs, threadId)
	const inTask = [...runs].reverse().filter((run) => !!taskGroupId && run.taskGroupId === taskGroupId)
	const live = own && isLiveRun(own) ? own : inTask.find(isLiveRun)
	if (live) return live
	const latest = own ?? inTask[0]
	if (!latest || dismissed.has(latest.id)) return undefined
	if (latest.status === "failed") return latest
	return latest.status === "done" && now - (latest.endedAt ?? 0) < DONE_SHOWN_MS ? latest : undefined
}

/**
 * A slim bar above the composer for where a run is now and what needs you: the step it's on, or what
 * it's waiting for with a jump to it, or why it failed with the fix and Retry. Steps, outcomes, time and
 * cost live on the task page (Task page).
 */
export function AutomationRunBar({ threadId, taskGroupId, onOpenTaskGroup }: AutomationRunBarProps) {
	const runs = useAutomationRuns()
	const navigation = useNavigationHistory()
	const [, setClosed] = useState(0)
	const run = pickRun(runs, threadId, taskGroupId, Date.now())
	if (!run) return null
	const openThread = (id: string) => (navigation ? navigation.navigate({ kind: "thread", id }) : void openTask(id))
	return (
		<RunBarBody
			key={run.id}
			onClose={() => {
				dismissed.add(run.id)
				setClosed((count) => count + 1)
			}}
			onOpenTaskGroup={onOpenTaskGroup}
			onOpenThread={openThread}
			run={run}
			threadId={threadId}
		/>
	)
}

function RunBarBody({
	run,
	threadId,
	onOpenThread,
	onOpenTaskGroup,
	onClose,
}: {
	run: AutomationRun
	threadId?: string
	onOpenThread: (threadId: string) => void
	onOpenTaskGroup?: (taskGroupId: string) => void
	onClose: () => void
}) {
	const actions = useRunActions(run)
	const at = currentStep(run)
	const needs = runNeeds(run)
	const failure = run.status === "failed" ? runFailure(run) : undefined
	const done = run.status === "done"
	// A need in another thread comes first; this thread's own approval is already on screen above.
	const need = needs.find((candidate) => candidate.threadId !== threadId) ?? needs[0]
	const needHere = !!need?.threadId && need.threadId === threadId
	const hereIndex = run.steps.findIndex((step) => step.threads.some((thread) => thread.threadId === threadId))
	const status = failure
		? `Failed at step ${at?.number ?? "?"}: ${failure.message}`
		: done
			? "Done. Ready for review is on the task page."
			: need
				? needHere
					? `Waiting for you here: ${need.text}`
					: `Waiting for you: ${need.text}`
				: at
					? `Step ${at.number} of ${run.steps.length}: ${at.step.title}`
					: "Running"
	return (
		<div
			className={cn(
				"mx-3.5 -mb-1 rounded-t-xs border border-b-0 bg-(--vscode-editorWidget-background) px-2.5 pt-1 pb-1.5 text-xs",
				failure ? "border-error/50" : need ? "border-warning/50" : "border-editor-group-border",
			)}
			data-testid="automation-run-bar">
			<div className="flex min-w-0 items-center gap-1.5">
				<StepStatusIcon status={failure ? "failed" : done ? "done" : need ? "waiting" : "running"} />
				<span className="min-w-0 flex-1 truncate font-semibold">{run.title}</span>
				{need?.threadId && !needHere && (
					<LinkButton
						className="shrink-0"
						data-testid="automation-run-bar-go"
						onClick={() => onOpenThread(need.threadId as string)}>
						Go to it
					</LinkButton>
				)}
				{onOpenTaskGroup && run.taskGroupId && (
					<LinkButton
						className="shrink-0"
						data-testid="automation-run-bar-task"
						onClick={() => onOpenTaskGroup(run.taskGroupId)}>
						{need && !need.threadId ? "Pick on the task page" : done ? "Review" : "Task page"}
					</LinkButton>
				)}
				{isLiveRun(run) ? (
					<LinkButton className="shrink-0" data-testid="automation-run-bar-stop" onClick={() => void stopRun(run.id)}>
						Stop
					</LinkButton>
				) : (
					<button
						aria-label="Close"
						className="flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-xs border-0 bg-transparent p-0 text-description hover:bg-list-hover hover:text-foreground"
						onClick={onClose}
						title="Close (the run stays on the task page)"
						type="button">
						<span aria-hidden className="codicon codicon-close text-[11px]!" />
					</button>
				)}
			</div>
			{/* Its own line, so it wraps instead of being cut off in a narrow sidebar. */}
			<div
				className={cn("mt-0.5 min-w-0 pl-4.5", failure ? "text-error" : need ? "text-warning" : "text-description")}
				data-testid="automation-run-bar-status">
				{status}
				{failure?.fix && (
					<>
						{" "}
						<FixLink automation={run.automation} className="whitespace-nowrap" fix={failure.fix} />
					</>
				)}
				{failure && (
					<>
						{" "}
						<LinkButton
							className="whitespace-nowrap"
							data-testid="automation-run-bar-retry"
							disabled={actions.busy}
							onClick={() => void actions.retry()}>
							{actions.busy ? "Starting…" : "Fixed it? Retry"}
						</LinkButton>
					</>
				)}
			</div>
			{isLiveRun(run) && (
				<div aria-hidden className="mt-1 h-0.5 w-full overflow-hidden rounded-full bg-editor-group-border">
					<div
						className="h-full bg-(--vscode-progressBar-background) transition-[width] motion-reduce:transition-none"
						style={{ width: `${Math.round(runFraction(run) * 100)}%` }}
					/>
				</div>
			)}
			{actions.problems.length > 0 && (
				<div className="mt-0.5 pl-4.5">
					<ProblemList automation={run.automation} problems={actions.problems} />
				</div>
			)}
			{hereIndex >= 0 && isLiveRun(run) && ["running", "waiting"].includes(run.steps[hereIndex].status) && (
				<div className="mt-1 text-[11px] text-description">
					This thread is step {hereIndex + 1} of {run.steps.length}. Typing here steps in.
				</div>
			)}
		</div>
	)
}
