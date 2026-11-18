import { isLiveRun } from "@shared/automations"
import { useState } from "react"
import { LinkButton } from "@/components/common/LinkButton"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useAutomationRuns } from "@/hooks/useAutomationRuns"
import { cn } from "@/lib/utils"
import { StepStatusIcon, stopRun } from "./RunBlock"
import { runForThread, runProgress } from "./runFacts"

interface AutomationRunBarProps {
	/** The thread on screen, if any. */
	threadId?: string
	/** The task on screen (its page, or the thread's task). */
	taskGroupId?: string
	onOpenTaskGroup?: (taskGroupId: string) => void
	now?: number
}

/**
 * A slim bar above the composer while a run is going in this task or thread: name, current step,
 * time and cost, a progress line, Stop, and a fold that lists the steps in place (no popup). The full
 * run lives on the task page.
 */
export function AutomationRunBar({ threadId, taskGroupId, onOpenTaskGroup, now = Date.now() }: AutomationRunBarProps) {
	const runs = useAutomationRuns()
	const { taskHistory } = useExtensionState()
	const [open, setOpen] = useState(false)
	const ownRun = runForThread(runs, threadId)
	const run =
		ownRun && isLiveRun(ownRun)
			? ownRun
			: [...runs]
					.reverse()
					.find((candidate) => isLiveRun(candidate) && !!taskGroupId && candidate.taskGroupId === taskGroupId)
	if (!run) return null
	const progress = runProgress(run, taskHistory, now)
	const here = ownRun?.id === run.id ? run.steps.findIndex((step) => step.threads.some((t) => t.threadId === threadId)) : -1
	const current = progress.currentStep
	return (
		<div
			className="mx-3.5 -mb-1 rounded-t-xs border border-b-0 border-editor-group-border bg-(--vscode-editorWidget-background) px-2.5 pt-1 pb-1.5 text-xs"
			data-testid="automation-run-bar">
			<div className="flex min-w-0 items-center gap-1.5">
				<span aria-hidden className="codicon codicon-run-all shrink-0 text-[11px]! text-description" />
				<button
					aria-expanded={open}
					className="flex min-w-0 flex-1 cursor-pointer items-baseline gap-1.5 border-0 bg-transparent p-0 text-left text-foreground"
					onClick={() => setOpen((value) => !value)}
					title={open ? "Hide the steps" : "Show the steps"}
					type="button">
					<span className="min-w-0 shrink truncate font-semibold">{run.title}</span>
					<span className={cn("shrink-0", run.status === "waiting" ? "text-warning" : "text-description")}>
						{run.status === "waiting" ? "waiting for you" : current ? current.title : progress.status}
					</span>
					<span className="min-w-0 truncate text-description">{progress.line}</span>
					<span
						aria-hidden
						className={cn("codicon shrink-0 text-[10px]!", open ? "codicon-chevron-down" : "codicon-chevron-up")}
					/>
				</button>
				{onOpenTaskGroup && (
					<LinkButton className="shrink-0" onClick={() => onOpenTaskGroup(run.taskGroupId)}>
						Task page
					</LinkButton>
				)}
				<LinkButton className="shrink-0" data-testid="automation-run-bar-stop" onClick={() => void stopRun(run.id)}>
					Stop
				</LinkButton>
			</div>
			<div aria-hidden className="mt-1 h-0.5 w-full overflow-hidden rounded-full bg-editor-group-border">
				<div
					className="h-full bg-(--vscode-progressBar-background)"
					style={{ width: `${Math.round(progress.fraction * 100)}%` }}
				/>
			</div>
			{here >= 0 && (
				<div className="mt-1 text-description">
					This thread is step {here + 1}. Typing here steps in; the step finishes when this thread replies.
				</div>
			)}
			{open && (
				<ol className="m-0 mt-1 list-none p-0" data-testid="automation-run-bar-steps">
					{run.steps.map((step, index) => (
						<li className="flex min-w-0 items-center gap-1.5 py-px" key={step.id}>
							<StepStatusIcon status={step.status} />
							<span className={cn("min-w-0 truncate", index === here && "font-semibold")}>{step.title}</span>
							{step.threads.length > 1 && (
								<span className="shrink-0 text-description">· {step.threads.length} together</span>
							)}
						</li>
					))}
				</ol>
			)}
		</div>
	)
}
