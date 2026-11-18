import {
	type AutomationRun,
	type AutomationRunStep,
	type AutomationRunStepStatus,
	type AutomationRunThread,
	isLiveRun,
} from "@shared/automations"
import { AnswerAutomationCheckpointRequest } from "@shared/proto/cline/automation"
import { StringRequest } from "@shared/proto/cline/common"
import { LoaderCircleIcon } from "lucide-react"
import { useState } from "react"
import { LinkButton } from "@/components/common/LinkButton"
import { type ThreadStatuses, threadStatusFor } from "@/components/inbox/threadStatus"
import { Button } from "@/components/ui/button"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { cn } from "@/lib/utils"
import { AutomationServiceClient } from "@/services/grpc-client"
import { ReadyForReview } from "./ReadyForReview"
import { runProgress, STEP_STATUS_LABELS } from "./runFacts"

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
		<span
			aria-label={label}
			className={cn("inline-block size-2 shrink-0 rounded-full", DOT[status], className)}
			role="img"
			title={label}
		/>
	)
}

/** The run's own status for a thread, made live by the thread's session (a run thread asking for approval waits). */
function liveThreadStatus(thread: AutomationRunThread, statuses: ThreadStatuses): AutomationRunStepStatus {
	if (!thread.threadId || (thread.status !== "running" && thread.status !== "waiting")) return thread.status
	return threadStatusFor(statuses, thread.threadId) === "waiting" ? "waiting" : thread.status
}

export const stopRun = (runId: string) =>
	AutomationServiceClient.stopAutomationRun(StringRequest.create({ value: runId })).catch((error) =>
		console.error("Failed to stop the run:", error),
	)

function ThreadRow({
	thread,
	statuses,
	onOpenThread,
}: {
	thread: AutomationRunThread
	statuses: ThreadStatuses
	onOpenThread: (threadId: string) => void
}) {
	const status = liveThreadStatus(thread, statuses)
	const detail = [thread.model || "Default model", thread.mode === "act" ? "Act" : "Ask", thread.worktree ? "worktree" : ""]
		.filter(Boolean)
		.join(" · ")
	return (
		<li className="flex min-w-0 flex-col py-0.5 pl-5" data-testid={`run-thread-${thread.id}`}>
			<div className="flex min-w-0 items-center gap-1.5">
				<StepStatusIcon status={status} />
				<span className="min-w-0 truncate">{thread.title}</span>
				<span className="min-w-0 flex-1 truncate text-description">{detail}</span>
				{status === "waiting" && <span className="shrink-0 text-warning">Needs you</span>}
				{thread.threadId && (
					<LinkButton className="shrink-0" onClick={() => onOpenThread(thread.threadId as string)}>
						Open
					</LinkButton>
				)}
			</div>
			{thread.error && <div className="pl-4.5 text-error">{thread.error}</div>}
			{thread.reply && status === "done" && (
				<div className="line-clamp-2 pl-4.5 text-description" title={thread.reply}>
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
		<div className="mt-1 ml-5 rounded-xs border border-warning/50 px-2 py-1.5" data-testid={`run-checkpoint-${step.id}`}>
			{step.question && <div className="mb-1 whitespace-pre-wrap">{step.question}</div>}
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

interface RunBlockProps {
	run: AutomationRun
	statuses: ThreadStatuses
	onOpenThread: (threadId: string) => void
	/** Opens a worktree thread's walkthrough (the Ready for review card's Walk through). */
	onWalkThrough?: (threadId: string) => void
	now?: number
	/** Finished runs start folded to one line. */
	defaultOpen?: boolean
	children?: React.ReactNode
}

/**
 * A run on its task page: every step with its status, the threads it started (indented when they run
 * together), elapsed time and cost, the Ask you choices right where they're needed, and Stop. Run
 * threads are normal threads: Open goes to one, and typing there steps in.
 */
export function RunBlock({ run, statuses, onOpenThread, onWalkThrough, now = Date.now(), defaultOpen, children }: RunBlockProps) {
	const { taskHistory } = useExtensionState()
	const live = isLiveRun(run)
	const [open, setOpen] = useState(defaultOpen ?? live)
	const progress = runProgress(run, taskHistory, now)
	const expanded = open || live
	return (
		<div
			className={cn(
				"mx-2 mb-2 rounded-sm border px-2 py-1.5 text-xs",
				run.status === "waiting" ? "border-warning/50" : "border-editor-group-border",
			)}
			data-testid={`run-block-${run.id}`}>
			<div className="flex min-w-0 items-center gap-1.5">
				<span aria-hidden className="codicon codicon-run-all shrink-0 text-[12px]! text-description" />
				<button
					aria-expanded={expanded}
					className="flex min-w-0 flex-1 cursor-pointer items-baseline gap-1.5 border-0 bg-transparent p-0 text-left text-foreground disabled:cursor-default"
					disabled={live}
					onClick={() => setOpen((value) => !value)}
					type="button">
					<span className="min-w-0 truncate font-semibold">{run.title}</span>
					<span
						className={cn(
							"shrink-0",
							run.status === "failed"
								? "text-error"
								: run.status === "waiting"
									? "text-warning"
									: "text-description",
						)}>
						{progress.status}
					</span>
					<span className="min-w-0 truncate text-description">{progress.line}</span>
				</button>
				{live && (
					<Button data-testid={`run-stop-${run.id}`} onClick={() => void stopRun(run.id)} size="xs" variant="secondary">
						Stop
					</Button>
				)}
			</div>
			{run.error && <div className="mt-1 text-error">{run.error}</div>}
			{expanded && (
				<ol className="m-0 mt-1 list-none p-0" data-testid={`run-steps-${run.id}`}>
					{run.steps.map((step) => (
						<li className="py-0.5" data-testid={`run-step-${step.id}`} key={step.id}>
							<div className="flex min-w-0 items-center gap-1.5">
								<StepStatusIcon status={step.status} />
								<span
									className={cn(
										"min-w-0 truncate",
										step.status === "skipped" && "text-description line-through",
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
							{step.error && step.threads.length === 0 && <div className="pl-4.5 text-error">{step.error}</div>}
							{step.threads.length > 0 && step.status !== "pending" && (
								<ul className="m-0 list-none p-0">
									{step.threads.map((thread) => (
										<ThreadRow
											key={thread.id}
											onOpenThread={onOpenThread}
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
			{live && <div className="mt-1 text-[11px] text-description">Open a thread and type to step in.</div>}
			{!live && expanded && (
				<ReadyForReview onOpenThread={onOpenThread} onWalkThrough={onWalkThrough ?? onOpenThread} run={run} />
			)}
			{children}
		</div>
	)
}
