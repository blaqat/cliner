import {
	type AutomationRun,
	type AutomationRunStep,
	type AutomationRunStepStatus,
	type AutomationRunThread,
	isLiveRun,
	resumePoints,
	retryPoint,
} from "@shared/automations"
import { AnswerAutomationCheckpointRequest } from "@shared/proto/cline/automation"
import { LoaderCircleIcon } from "lucide-react"
import { useState } from "react"
import { LinkButton } from "@/components/common/LinkButton"
import { type ThreadStatuses, threadStatusFor } from "@/components/inbox/threadStatus"
import { Button } from "@/components/ui/button"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useAutomations } from "@/hooks/useAutomations"
import { cn } from "@/lib/utils"
import { AutomationServiceClient } from "@/services/grpc-client"
import { ReadyForReview } from "./ReadyForReview"
import { FixLink, ProblemList, stopRun, useRunActions } from "./runActions"
import { runStatusText, runTimeAndCost, STEP_STATUS_LABELS } from "./runFacts"

export { stopRun } from "./runActions"

const DOT: Record<Exclude<AutomationRunStepStatus, "running">, string> = {
	pending: "border border-description/60 bg-transparent",
	waiting: "bg-warning",
	done: "bg-success",
	failed: "bg-error",
	stopped: "bg-description",
	skipped: "border border-dashed border-description/60 bg-transparent",
}

export function StepStatusIcon({ status, className }: { status: AutomationRunStepStatus; className?: string }) {
	const label = STEP_STATUS_LABELS[status]
	if (status === "running")
		return (
			<LoaderCircleIcon
				aria-label={label}
				className={cn("size-3 shrink-0 animate-spin text-link motion-reduce:animate-none", className)}
				role="img"
			/>
		)
	return (
		<span className="flex size-3 shrink-0 items-center justify-center">
			<span
				aria-label={label}
				className={cn("inline-block size-2 shrink-0 rounded-full", DOT[status], className)}
				role="img"
				title={label}
			/>
		</span>
	)
}

/** The run's status for a thread, made live by its session (a thread asking for approval is waiting). */
function liveThreadStatus(thread: AutomationRunThread, statuses: ThreadStatuses): AutomationRunStepStatus {
	if (!thread.threadId || (thread.status !== "running" && thread.status !== "waiting")) return thread.status
	return threadStatusFor(statuses, thread.threadId) === "waiting" ? "waiting" : thread.status
}

function ThreadRow({
	run,
	thread,
	nested,
	statuses,
	onOpenThread,
}: {
	run: AutomationRun
	thread: AutomationRunThread
	/** One of a step's threads together: indented under the step. */
	nested: boolean
	statuses: ThreadStatuses
	onOpenThread: (threadId: string) => void
}) {
	const status = liveThreadStatus(thread, statuses)
	const detail = [thread.model || "Default model", thread.mode === "act" ? "Act" : "Ask", thread.worktree ? "worktree" : ""]
		.filter(Boolean)
		.join(" · ")
	const waiting = status === "waiting"
	// Lines under a thread of several line up with its title, past its status dot.
	const under = nested ? "ml-4.5" : ""
	return (
		<li className="flex min-w-0 flex-col py-0.5 pl-9" data-testid={`run-thread-${thread.id}`}>
			<div className="flex min-w-0 items-center gap-1.5">
				{nested && <StepStatusIcon status={status} />}
				{nested && <span className="min-w-0 shrink truncate">{thread.title}</span>}
				<span className="min-w-0 flex-1 truncate text-description">{detail}</span>
				{thread.threadId && !waiting && (
					<LinkButton className="shrink-0" onClick={() => onOpenThread(thread.threadId as string)}>
						Open
					</LinkButton>
				)}
			</div>
			{waiting && (
				<div
					className={cn("mt-0.5 flex min-w-0 items-baseline gap-1.5 rounded-xs bg-warning/10 px-1.5 py-0.5", under)}
					data-testid={`run-waiting-${thread.id}`}>
					<span className="min-w-0 flex-1 text-warning">
						Waiting for you: {thread.waitingOn ?? "it needs your answer in the thread"}
					</span>
					{thread.threadId && (
						<LinkButton className="shrink-0" onClick={() => onOpenThread(thread.threadId as string)}>
							Go to it
						</LinkButton>
					)}
				</div>
			)}
			{thread.error && (
				<div className={cn("text-error", under)} data-testid={`run-error-${thread.id}`}>
					{thread.error} {thread.fix && <FixLink automation={run.automation} fix={thread.fix} />}
				</div>
			)}
			{thread.reply && status === "done" && (
				<div className={cn("line-clamp-2 text-description", under)} title={thread.reply}>
					{thread.reply}
				</div>
			)}
		</li>
	)
}

function CheckpointChoices({
	run,
	step,
	onOpenThread,
}: {
	run: AutomationRun
	step: AutomationRunStep
	onOpenThread: (id: string) => void
}) {
	const [error, setError] = useState("")
	const [sending, setSending] = useState(false)
	// Choices that come from a group of threads can be read before picking.
	const source = run.steps.find(
		(candidate) =>
			candidate.kind === "together" && step.choices?.every((choice) => candidate.threads.some((t) => t.title === choice)),
	)
	return (
		<div className="mt-1 ml-9 rounded-xs bg-warning/10 px-2 py-1.5" data-testid={`run-checkpoint-${step.id}`}>
			<div className="mb-1 whitespace-pre-wrap text-warning">
				Waiting for you: {step.question?.trim() || "pick how to go on"}
			</div>
			<div className="flex flex-wrap items-center gap-1.5">
				{(step.choices ?? []).map((choice) => {
					const thread = source?.threads.find((candidate) => candidate.title === choice)
					return (
						<span className="flex items-center gap-1" key={choice}>
							<Button
								disabled={sending}
								onClick={() => {
									setSending(true)
									AutomationServiceClient.answerAutomationCheckpoint(
										AnswerAutomationCheckpointRequest.create({ runId: run.id, stepId: step.id, choice }),
									)
										.catch((err) => setError(err?.message ?? String(err)))
										.finally(() => setSending(false))
								}}
								size="xs"
								variant="secondary">
								{choice}
							</Button>
							{thread?.threadId && (
								<LinkButton onClick={() => onOpenThread(thread.threadId as string)}>Read</LinkButton>
							)}
						</span>
					)
				})}
			</div>
			{error && <div className="mt-1 text-error">{error}</div>}
		</div>
	)
}

/** Retry, Resume from an earlier step, and Run again, under a finished run. */
function RunActions({ run }: { run: AutomationRun }) {
	const { automations } = useAutomations()
	const definition = automations.find((item) => item.name === run.automation)?.definition
	const actions = useRunActions(run)
	const [choosing, setChoosing] = useState(false)
	const retry = run.status === "done" ? undefined : retryPoint(run)
	const retryNumber = retry ? run.steps.indexOf(retry) + 1 : 0
	// Earlier steps the run can go back to (the retry step has its own button).
	const points = resumePoints(run, definition).filter((id) => id !== retry?.id)
	const [from, setFrom] = useState("")
	const fromId = points.includes(from) ? from : (points.at(-1) ?? "")
	const stepLabel = (id: string) => {
		const index = run.steps.findIndex((step) => step.id === id)
		const title = run.steps[index]?.title ?? definition?.steps.find((step) => step.id === id)?.title ?? id
		return `${index >= 0 ? index + 1 : "?"} · ${title}`
	}
	return (
		<div className="mt-1.5" data-testid={`run-actions-${run.id}`}>
			<div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
				{retry && (
					<Button
						data-testid={`run-retry-${run.id}`}
						disabled={actions.busy}
						onClick={() => void actions.retry()}
						size="xs"
						title={`Runs step ${retryNumber} again. Steps before it keep their threads and replies.`}>
						{run.status === "failed" ? `Retry step ${retryNumber}` : `Resume at step ${retryNumber}`}
					</Button>
				)}
				<Button
					data-testid={`run-again-${run.id}`}
					disabled={actions.busy}
					onClick={() => void actions.runAgain()}
					size="xs"
					title="A fresh run with the same values, in this task"
					variant="secondary">
					Run again
				</Button>
				{points.length > 0 && !choosing && (
					<LinkButton data-testid={`run-resume-from-${run.id}`} onClick={() => setChoosing(true)}>
						{retry ? "Go back to an earlier step…" : "Redo from a step…"}
					</LinkButton>
				)}
				{actions.busy && (
					<span className="text-description" data-testid={`run-starting-${run.id}`} role="status">
						Starting the run…
					</span>
				)}
			</div>
			{choosing && (
				<div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5">
					<select
						aria-label="Step to go on from"
						className="min-w-0 max-w-full flex-1 rounded-xs border border-(--vscode-dropdown-border) bg-(--vscode-dropdown-background) px-1 py-0.5 text-xs text-(--vscode-dropdown-foreground)"
						data-testid={`run-resume-step-${run.id}`}
						onChange={(event) => setFrom(event.target.value)}
						value={fromId}>
						{points.map((id) => (
							<option key={id} value={id}>
								{stepLabel(id)}
							</option>
						))}
					</select>
					<Button
						disabled={actions.busy || !fromId}
						onClick={() => {
							setChoosing(false)
							void actions.resumeFrom(fromId)
						}}
						size="xs"
						variant="secondary">
						Go on from here
					</Button>
					<LinkButton onClick={() => setChoosing(false)}>Cancel</LinkButton>
					<div className="w-full text-[11px] text-description">
						That step and every step after it run again; earlier ones keep their threads and replies.
					</div>
				</div>
			)}
			{actions.problems.length > 0 && (
				<div className="mt-1">
					<ProblemList automation={run.automation} problems={actions.problems} />
				</div>
			)}
		</div>
	)
}

interface RunBlockProps {
	run: AutomationRun
	statuses: ThreadStatuses
	onOpenThread: (threadId: string) => void
	/** Opens a worktree thread's walkthrough (the Ready for review card's Walk through). */
	onWalkThrough?: (threadId: string) => void
	/** Notes each thread wrote, for Ready for review. */
	notesWritten?: ReadonlyMap<string, readonly string[]>
	noteNames?: ReadonlyMap<string, string>
	onOpenNote?: (slug: string) => void
	now?: number
	/** Finished runs start folded to one line. */
	defaultOpen?: boolean
}

/**
 * A run on its task page: the one place with its steps and their outcomes. Each step shows its threads
 * (indented when they ran together) and replies; what it's waiting for, with a jump to it; why it failed,
 * with a link to the fix; then Retry, Resume from a step, or Run again once it ends. Time and cost live
 * in its header. Ready for review (when done) lists only what to look at: code to walk through and notes
 * the run wrote.
 */
export function RunBlock({
	run,
	statuses,
	onOpenThread,
	onWalkThrough,
	notesWritten,
	noteNames,
	onOpenNote,
	now = Date.now(),
	defaultOpen,
}: RunBlockProps) {
	const { taskHistory } = useExtensionState()
	const live = isLiveRun(run)
	const [open, setOpen] = useState(defaultOpen ?? live)
	const expanded = open || live || run.status === "failed"
	const tone =
		run.status === "failed"
			? "text-error"
			: run.status === "waiting"
				? "text-warning"
				: run.status === "done"
					? "text-success"
					: "text-description"
	return (
		<div
			className={cn(
				"mx-2 mb-2 rounded-sm border px-2 py-1.5 text-xs",
				run.status === "waiting"
					? "border-warning/50"
					: run.status === "failed"
						? "border-error/40"
						: "border-editor-group-border",
			)}
			data-testid={`run-block-${run.id}`}>
			<div className="flex min-w-0 items-center gap-1.5">
				<button
					aria-expanded={expanded}
					className="flex min-w-0 flex-1 cursor-pointer items-baseline gap-1.5 border-0 bg-transparent p-0 text-left text-foreground disabled:cursor-default"
					disabled={live || run.status === "failed"}
					onClick={() => setOpen((value) => !value)}
					title={live ? undefined : expanded ? "Fold" : "Show the steps"}
					type="button">
					{!live && run.status !== "failed" && (
						<span
							aria-hidden
							className={cn(
								"codicon shrink-0 self-center text-[10px]!",
								expanded ? "codicon-chevron-down" : "codicon-chevron-right",
							)}
						/>
					)}
					<span className="min-w-0 truncate font-semibold">{run.title}</span>
					<span className={cn("shrink-0", tone)} data-testid={`run-status-${run.id}`}>
						{runStatusText(run)}
					</span>
					<span className="ml-auto min-w-0 shrink truncate pl-1 text-description">
						{runTimeAndCost(run, taskHistory, now)}
					</span>
				</button>
				{live && (
					<Button data-testid={`run-stop-${run.id}`} onClick={() => void stopRun(run.id)} size="xs" variant="secondary">
						Stop
					</Button>
				)}
			</div>
			{expanded && (
				<ol className="m-0 mt-1 list-none p-0" data-testid={`run-steps-${run.id}`}>
					{run.steps.map((step, index) => (
						<li className="py-0.5" data-testid={`run-step-${step.id}`} key={step.id}>
							<div className="flex min-w-0 items-center gap-1.5">
								<StepStatusIcon status={step.status} />
								<span className="w-3 shrink-0 text-right text-description">{index + 1}</span>
								<span
									className={cn(
										"min-w-0 truncate",
										step.status === "skipped" || step.status === "pending" ? "text-description" : "",
									)}>
									{step.title}
								</span>
								{step.kind === "together" && (
									<span className="shrink-0 text-description">· {step.threads.length} together</span>
								)}
								{step.kind === "checkpoint" && step.choice && (
									<span className="min-w-0 truncate text-description">· you picked {step.choice}</span>
								)}
							</div>
							{step.error && step.threads.every((thread) => !thread.error) && (
								<div className="ml-9 text-error">
									{step.error} {step.fix && <FixLink automation={run.automation} fix={step.fix} />}
								</div>
							)}
							{step.threads.length > 0 && step.status !== "pending" && step.status !== "skipped" && (
								<ul className="m-0 list-none p-0">
									{step.threads.map((thread) => (
										<ThreadRow
											key={thread.id}
											nested={step.kind === "together"}
											onOpenThread={onOpenThread}
											run={run}
											statuses={statuses}
											thread={thread}
										/>
									))}
								</ul>
							)}
							{step.kind === "checkpoint" && step.status === "waiting" && (
								<CheckpointChoices onOpenThread={onOpenThread} run={run} step={step} />
							)}
						</li>
					))}
				</ol>
			)}
			{expanded && run.error && (
				<div className={cn("mt-1", run.status === "failed" ? "text-error" : "text-description")}>
					{run.error} {run.fix && <FixLink automation={run.automation} fix={run.fix} />}
				</div>
			)}
			{live && expanded && (
				<div className="mt-1 text-[11px] text-description">
					Its threads are normal threads: open one and type to step in.
				</div>
			)}
			{run.status === "done" && expanded && (
				<ReadyForReview
					noteNames={noteNames}
					notesWritten={notesWritten}
					onOpenNote={onOpenNote}
					onWalkThrough={onWalkThrough ?? onOpenThread}
					run={run}
				/>
			)}
			{!live && expanded && <RunActions run={run} />}
		</div>
	)
}
