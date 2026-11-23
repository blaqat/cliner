import {
	type AutomationRun,
	type AutomationRunItem,
	type AutomationRunStep,
	type AutomationRunStepStatus,
	type AutomationRunThread,
	isLiveRun,
	resumePoints,
	stepsForRun,
} from "@shared/automations"
import { AnswerAutomationCheckpointRequest } from "@shared/proto/cline/automation"
import { LoaderCircleIcon } from "lucide-react"
import { useReducer, useRef, useState } from "react"
import { LinkButton } from "@/components/common/LinkButton"
import { type ThreadStatuses, threadStatusFor } from "@/components/inbox/threadStatus"
import { Button } from "@/components/ui/button"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useAutomationRuns } from "@/hooks/useAutomationRuns"
import { useAutomations } from "@/hooks/useAutomations"
import { cn } from "@/lib/utils"
import { AutomationServiceClient } from "@/services/grpc-client"
import { ReadyForReview } from "./ReadyForReview"
import { MissingOutputs, RunOutput } from "./RunThreadOutputs"
import { ProblemDetails, ProblemList, stopRun, useRunActions } from "./runActions"
import { currentStep, runNeeds, runStatusText, runTimeAndCost, STEP_STATUS_LABELS } from "./runFacts"

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
	onOpenNote,
	actions,
}: {
	run: AutomationRun
	thread: AutomationRunThread
	/** One of a step's threads together: indented under the step. */
	nested: boolean
	statuses: ThreadStatuses
	onOpenThread: (threadId: string) => void
	onOpenNote?: (slug: string) => void
	actions: ReturnType<typeof useRunActions>
}) {
	const status = liveThreadStatus(thread, statuses)
	const detail = [
		thread.model || "Default model",
		thread.mode === "act" ? "Act" : "Ask",
		thread.worktreeScope === "task" ? "task worktree" : thread.worktree ? "worktree" : "",
	]
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
			{waiting && !!thread.missingOutputs?.length && thread.threadId && (
				<div className={under}>
					<MissingOutputs
						names={thread.missingOutputs}
						onOpenThread={onOpenThread}
						runId={run.id}
						threadId={thread.threadId}
					/>
				</div>
			)}
			{waiting && !thread.missingOutputs?.length && (
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
			{thread.error && !actions.problems && (
				<div className={cn("text-error", under)} data-testid={`run-error-${thread.id}`}>
					<ProblemDetails
						automation={run.automation}
						onRecheck={actions.onRecheck}
						problem={{ message: thread.error, fix: thread.fix }}
					/>
				</div>
			)}
			{thread.reply && status === "done" && (
				<div className={cn("line-clamp-2 text-description", under)} title={thread.reply}>
					{thread.reply}
				</div>
			)}
			{!!thread.outputs?.length && (
				<ul className={cn("m-0 list-none p-0", under)}>
					{thread.outputs.map((output) => (
						<RunOutput
							key={`${thread.threadId}:${output.name}`}
							onOpenNote={onOpenNote}
							output={output}
							runId={run.id}
							stepId={thread.id}
						/>
					))}
				</ul>
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
function RunActions({ run, actions }: { run: AutomationRun; actions: ReturnType<typeof useRunActions> }) {
	const { automations } = useAutomations()
	const definition = automations.find((item) => item.name === run.automation)?.definition
	const [choosing, setChoosing] = useState(false)
	const { points: resumeIds, retryId } = resumePoints(run, definition)
	const steps = definition ? stepsForRun(definition.steps, run) : run.steps
	const retryNumber = steps.findIndex((step) => step.id === retryId) + 1
	// Earlier steps the run can go back to (the retry step has its own button).
	const points = resumeIds.filter((id) => id !== retryId)
	const [from, setFrom] = useState("")
	const fromId = points.includes(from) ? from : (points.at(-1) ?? "")
	const stepLabel = (id: string) => {
		const index = steps.findIndex((step) => step.id === id)
		const title = run.steps.find((step) => step.id === id)?.title ?? steps[index]?.title ?? id
		return `${index >= 0 ? index + 1 : "?"} · ${title}`
	}
	return (
		<div className="mt-1.5" data-testid={`run-actions-${run.id}`}>
			<div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
				{retryId && (
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
					title={
						run.parent
							? "Runs this item's steps again from the first, in this task"
							: "A fresh run with the same values and context, in this task"
					}
					variant="secondary">
					{run.parent ? "Run this item again" : "Run again"}
				</Button>
				{points.length > 0 && !choosing && (
					<LinkButton data-testid={`run-resume-from-${run.id}`} onClick={() => setChoosing(true)}>
						{retryId ? "Go back to an earlier step…" : "Redo from a step…"}
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
			{!!actions.problems?.length && (
				<div className="mt-1">
					<ProblemList automation={run.automation} onRecheck={actions.onRecheck} problems={actions.problems} />
				</div>
			)}
			{actions.ready && <div className="mt-1 text-description">Git is set up. Retry the step.</div>}
		</div>
	)
}

/** Folds the user picked this session, by run and by step. A resumed run starts over with the defaults. */
const userFolds = new Map<string, boolean>()

export function clearRunFoldsForTest() {
	userFolds.clear()
}

function foldKey(run: AutomationRun, stepId?: string): string {
	return `${run.id}@${run.resumedAt ?? 0}${stepId ? `#${stepId}` : ""}`
}

/** A step's status with its threads in mind: a running step with a thread waiting on you is waiting. */
function stepStatus(step: AutomationRunStep): AutomationRunStepStatus {
	return step.status === "running" && step.threads.some((thread) => thread.status === "waiting") ? "waiting" : step.status
}

const started = (step: AutomationRunStep) => step.status !== "pending" && step.status !== "skipped"

/**
 * Whether a step starts open: the one running or waiting and a failed one do; a finished one folds once a
 * later step has started, so a finished run shows its last step open.
 */
export function stepOpenByDefault(run: AutomationRun, index: number): boolean {
	const step = run.steps[index]
	const status = stepStatus(step)
	if (status === "running" || status === "waiting" || status === "failed" || step.error) return true
	if (!started(step)) return false
	return !run.steps.slice(index + 1).some(started)
}

function Caret({ open }: { open: boolean }) {
	return (
		<span
			aria-hidden
			className={cn(
				"codicon codicon-chevron-right w-2.5 shrink-0 self-center text-[10px]! transition-transform duration-150 motion-reduce:transition-none",
				open && "rotate-90",
			)}
		/>
	)
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`

const ITEM_STATUS_TEXT: Partial<Record<AutomationRunStepStatus, string>> = {
	pending: "Waiting its turn",
	waiting: "Needs you in its task",
	skipped: "Skipped",
}

/** A For each step's items: each with its status, where it is, and its task. */
function ItemRows({ items, onOpenTask }: { items: readonly AutomationRunItem[]; onOpenTask?: (taskGroupId: string) => void }) {
	return (
		<ul className="m-0 list-none p-0" data-testid="run-items">
			{items.map((item) => {
				const where =
					item.status === "running"
						? (item.at ?? "")
						: item.status === "done"
							? ""
							: (ITEM_STATUS_TEXT[item.status] ?? (item.at ? `at ${item.at}` : ""))
				return (
					<li className="flex min-w-0 flex-col py-0.5 pl-9" data-testid={`run-item-${item.label}`} key={item.item}>
						<div className="flex min-w-0 items-center gap-1.5">
							<StepStatusIcon status={item.status} />
							<span className="ph-no-capture min-w-0 shrink truncate" title={item.item}>
								{item.label}
							</span>
							<span
								className={cn(
									"min-w-0 flex-1 truncate",
									item.status === "waiting" ? "text-warning" : "text-description",
								)}>
								{where}
							</span>
							{item.taskGroupId && onOpenTask && (
								<LinkButton className="shrink-0" onClick={() => onOpenTask(item.taskGroupId as string)}>
									Open task
								</LinkButton>
							)}
						</div>
						{item.error && (item.status === "failed" || item.status === "stopped") && (
							<div className="ml-4.5 line-clamp-2 text-error" title={item.error}>
								{item.error}
							</div>
						)}
					</li>
				)
			})}
		</ul>
	)
}

/** "2 of 3 done" for a For each step's header. */
function itemsSummary(items: readonly AutomationRunItem[]): string {
	const done = items.filter((item) => item.status === "done").length
	const failed = items.filter((item) => item.status === "failed" || item.status === "stopped").length
	return [`${done} of ${items.length} done`, failed ? `${failed} didn't finish` : ""].filter(Boolean).join(", ")
}

function StepRow({
	run,
	step,
	index,
	open,
	onToggle,
	statuses,
	onOpenThread,
	onOpenNote,
	onOpenTask,
	actions,
}: {
	run: AutomationRun
	step: AutomationRunStep
	index: number
	open: boolean
	onToggle: () => void
	statuses: ThreadStatuses
	onOpenThread: (threadId: string) => void
	onOpenNote?: (slug: string) => void
	onOpenTask?: (taskGroupId: string) => void
	actions: ReturnType<typeof useRunActions>
}) {
	const status = stepStatus(step)
	const showError = !!step.error && !actions.problems && step.threads.every((thread) => !thread.error)
	const showThreads = step.threads.length > 0 && started(step)
	const showChoices = step.kind === "checkpoint" && step.status === "waiting"
	const showItems = !!step.items?.length
	const foldable = showError || showThreads || showChoices || showItems
	const outputs = step.threads.reduce((count, thread) => count + (thread.outputs?.length ?? 0), 0)
	const needsYou =
		status === "waiting" || step.threads.some((thread) => liveThreadStatus(thread, statuses) === "waiting" && started(step))
	const headerClass = "flex w-full min-w-0 items-center gap-1.5 text-left text-foreground"
	const header = (
		<>
			{foldable ? <Caret open={open} /> : <span aria-hidden className="w-2.5 shrink-0" />}
			<StepStatusIcon status={status} />
			<span className="w-3 shrink-0 text-right text-description">{index + 1}</span>
			<span className={cn("min-w-0 truncate", started(step) ? "" : "text-description")}>{step.title}</span>
			{step.kind === "together" && <span className="shrink-0 text-description">· {step.threads.length} together</span>}
			{showItems && (
				<span className="min-w-0 truncate text-description" data-testid={`run-step-items-${step.id}`}>
					· {itemsSummary(step.items ?? [])}
				</span>
			)}
			{step.kind === "checkpoint" && step.choice && (
				<span className="min-w-0 truncate text-description">· you picked {step.choice}</span>
			)}
			{outputs > 0 && (
				<span className="shrink-0 text-description" data-testid={`run-step-outputs-${step.id}`}>
					· {plural(outputs, "output")}
				</span>
			)}
			{foldable && !open && needsYou && (
				<span className="shrink-0 text-warning" data-testid={`run-step-needs-${step.id}`}>
					· needs you
				</span>
			)}
		</>
	)
	return (
		<li className="py-0.5" data-testid={`run-step-${step.id}`}>
			{foldable ? (
				<button
					aria-controls={`run-step-body-${run.id}-${step.id}`}
					aria-expanded={open}
					className={cn(
						headerClass,
						"cursor-pointer rounded-xs border-0 bg-transparent p-0 font-[inherit] focus-visible:outline focus-visible:outline-1 focus-visible:outline-(--vscode-focusBorder)",
					)}
					data-testid={`run-step-toggle-${step.id}`}
					onClick={onToggle}
					title={open ? "Fold" : "Unfold"}
					type="button">
					{header}
				</button>
			) : (
				<div className={headerClass}>{header}</div>
			)}
			{foldable && open && (
				<div className="pl-4" id={`run-step-body-${run.id}-${step.id}`}>
					{showError && (
						<div className="ml-9 text-error">
							<ProblemDetails
								automation={run.automation}
								onRecheck={actions.onRecheck}
								problem={{ message: step.error as string, fix: step.fix }}
							/>
						</div>
					)}
					{showThreads && (
						<ul className="m-0 list-none p-0">
							{step.threads.map((thread) => (
								<ThreadRow
									actions={actions}
									key={thread.id}
									nested={step.kind === "together"}
									onOpenNote={onOpenNote}
									onOpenThread={onOpenThread}
									run={run}
									statuses={statuses}
									thread={thread}
								/>
							))}
						</ul>
					)}
					{showChoices && <CheckpointChoices onOpenThread={onOpenThread} run={run} step={step} />}
					{showItems && <ItemRows items={step.items ?? []} onOpenTask={onOpenTask} />}
				</div>
			)}
		</li>
	)
}

/** The folded run's second line: what it waits on (with where to answer it), else the step it's on. */
function FoldedRunLine({
	run,
	onOpenThread,
	onShow,
}: {
	run: AutomationRun
	onOpenThread: (threadId: string) => void
	onShow: (stepId: string) => void
}) {
	const need = runNeeds(run)[0]
	if (need) {
		const thread = run.steps
			.find((step) => step.id === need.stepId)
			?.threads.find((candidate) => candidate.threadId === need.threadId)
		// Missing outputs and Ask you steps are answered here, on the task page.
		const answerHere = !need.threadId || !!thread?.missingOutputs?.length
		return (
			<div
				className="mt-0.5 flex min-w-0 items-baseline gap-1.5 rounded-xs bg-warning/10 px-1.5 py-0.5"
				data-testid={`run-folded-need-${run.id}`}>
				{/* The header already says Waiting for you. */}
				<span className="min-w-0 flex-1 text-warning">{need.text}</span>
				{answerHere ? (
					<LinkButton className="shrink-0" onClick={() => onShow(need.stepId)}>
						Show
					</LinkButton>
				) : (
					<LinkButton className="shrink-0" onClick={() => onOpenThread(need.threadId as string)}>
						Go to it
					</LinkButton>
				)}
			</div>
		)
	}
	if (!isLiveRun(run)) return null
	const at = currentStep(run)
	if (!at) return null
	return (
		<div className="mt-0.5 min-w-0 truncate pl-4 text-description" data-testid={`run-folded-step-${run.id}`}>
			Step {at.number} of {run.steps.length}: {at.step.title}
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
	/** Opens a task page: a For each item's task, or the task of the run an item belongs to. */
	onOpenTask?: (taskGroupId: string) => void
	now?: number
	/** Whether it starts open; live and failed runs always do. */
	defaultOpen?: boolean
}

/** What the user added when starting the run: its text (two lines, all on hover) and attachments. */
function RunContext({ context }: { context: NonNullable<AutomationRun["context"]> }) {
	const attached = [
		context.images ? `${context.images} image${context.images === 1 ? "" : "s"}` : "",
		...(context.files ?? []).map((file) => file.split(/[\\/]/).at(-1) ?? file),
	].filter(Boolean)
	return (
		<div className="mt-1 rounded-xs bg-text-block-background px-1.5 py-0.5" data-testid="run-context">
			<div className="text-[11px] text-description">Context from you</div>
			{context.text && (
				<div className="ph-no-capture line-clamp-2 whitespace-pre-wrap" title={context.text}>
					{context.text}
				</div>
			)}
			{attached.length > 0 && <div className="truncate text-description">{attached.join(" · ")}</div>}
		</div>
	)
}

/** An item's run says which item it is and links to the run that fanned out. */
function ItemOf({ run, onOpenTask }: { run: AutomationRun; onOpenTask?: (taskGroupId: string) => void }) {
	const runs = useAutomationRuns()
	if (!run.parent) return null
	const parent = runs.find((candidate) => candidate.id === run.parent?.runId)
	return (
		<div className="mt-0.5 flex min-w-0 items-baseline gap-1.5 pl-4 text-description" data-testid={`run-item-of-${run.id}`}>
			<span className="ph-no-capture min-w-0 truncate" title={run.parent.item}>
				Item {run.parent.index + 1} of {run.parent.total}: {run.parent.item.split("\n")[0]}
			</span>
			{parent?.taskGroupId && parent.taskGroupId !== run.taskGroupId && onOpenTask && (
				<LinkButton className="shrink-0" onClick={() => onOpenTask(parent.taskGroupId)}>
					All items
				</LinkButton>
			)}
		</div>
	)
}

/**
 * A run on its task page: the one place with its steps and their outcomes. Each step shows its threads
 * (indented when they ran together) and replies; what it's waiting for, with a jump to it; why it failed,
 * with a link to the fix; then Retry, Resume from a step, or Run again once it ends. Time and cost live
 * in its header. The run and each step fold; a folded run still says what it waits on. Ready for review (when done) lists only what to look at: code to walk through and notes
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
	onOpenTask,
	now = Date.now(),
	defaultOpen,
}: RunBlockProps) {
	const { taskHistory } = useExtensionState()
	const allRuns = useAutomationRuns()
	const actions = useRunActions(run)
	const timeAndCost = runTimeAndCost(run, taskHistory, now, allRuns)
	const live = isLiveRun(run)
	const [, refold] = useReducer((count: number) => count + 1, 0)
	const [initialOpen] = useState(defaultOpen ?? live)
	// A run you watched finish stays open.
	const sawLive = useRef(live)
	if (live) sawLive.current = true
	const setOpen = (key: string, open: boolean) => {
		userFolds.set(key, open)
		refold()
	}
	const expanded = userFolds.get(foldKey(run)) ?? (live || run.status === "failed" || sawLive.current || initialOpen)
	const stepOpen = (index: number) => userFolds.get(foldKey(run, run.steps[index].id)) ?? stepOpenByDefault(run, index)
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
					aria-controls={`run-steps-${run.id}`}
					aria-expanded={expanded}
					className="flex min-w-0 flex-1 cursor-pointer items-baseline gap-1.5 rounded-xs border-0 bg-transparent p-0 text-left font-[inherit] text-foreground focus-visible:outline focus-visible:outline-1 focus-visible:outline-(--vscode-focusBorder)"
					data-testid={`run-toggle-${run.id}`}
					onClick={() => setOpen(foldKey(run), !expanded)}
					title={expanded ? "Fold" : "Unfold"}
					type="button">
					<Caret open={expanded} />
					<span className="min-w-0 truncate font-semibold">{run.title}</span>
					<span className={cn("shrink-0", tone)} data-testid={`run-status-${run.id}`}>
						{runStatusText(run)}
					</span>
					<span className="ml-auto min-w-0 shrink truncate pl-1 text-description" title={timeAndCost}>
						{timeAndCost}
					</span>
				</button>
				{live && (
					<Button data-testid={`run-stop-${run.id}`} onClick={() => void stopRun(run.id)} size="xs" variant="secondary">
						Stop
					</Button>
				)}
			</div>
			<ItemOf onOpenTask={onOpenTask} run={run} />
			{!expanded && (
				<FoldedRunLine
					onOpenThread={onOpenThread}
					onShow={(stepId) => {
						userFolds.set(foldKey(run, stepId), true)
						setOpen(foldKey(run), true)
					}}
					run={run}
				/>
			)}
			{expanded && run.context && <RunContext context={run.context} />}
			{expanded && (
				<ol className="m-0 mt-1 list-none p-0" data-testid={`run-steps-${run.id}`} id={`run-steps-${run.id}`}>
					{run.steps.map((step, index) => (
						<StepRow
							actions={actions}
							index={index}
							key={step.id}
							onOpenNote={onOpenNote}
							onOpenTask={onOpenTask}
							onOpenThread={onOpenThread}
							onToggle={() => setOpen(foldKey(run, step.id), !stepOpen(index))}
							open={stepOpen(index)}
							run={run}
							statuses={statuses}
							step={step}
						/>
					))}
				</ol>
			)}
			{expanded && run.error && !actions.problems && (
				<div className={cn("mt-1", run.status === "failed" ? "text-error" : "text-description")}>
					<ProblemDetails
						automation={run.automation}
						onRecheck={actions.onRecheck}
						problem={{ message: run.error, fix: run.fix }}
					/>
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
			{!live && expanded && <RunActions actions={actions} run={run} />}
		</div>
	)
}
