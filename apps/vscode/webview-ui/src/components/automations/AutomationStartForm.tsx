import {
	type AutomationProblem,
	type AutomationStep,
	automationDisplayName,
	formatAutomationCost,
	placesContext,
} from "@shared/automations"
import type React from "react"
import { useCallback, useEffect, useRef, useState } from "react"
import { LinkButton } from "@/components/common/LinkButton"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useAutomationRuns } from "@/hooks/useAutomationRuns"
import { cn } from "@/lib/utils"
import { type AutomationDraft, automationDraftValues } from "./automationInput"
import { checkAutomation, ProblemList } from "./runActions"
import { describeRun, summarizeRun } from "./willRun"

interface AutomationStartFormProps {
	draft: AutomationDraft
	/** The argument chip being edited: the steps that use it are marked. */
	focusedArg?: string
	/** Images and files attached in the composer: they go with the context. */
	attachments: { images: number; files: number }
	/** The run goes into this task (the composer is in it). */
	taskGroupId?: string
	taskTitle?: string
	/** Trusts the version on screen (a file someone else changed). */
	onTrust: () => void
	onViewFile: () => void
	/** Why the last Run didn't start. */
	error?: string
}

const CHIP_CLASS =
	"cursor-pointer rounded-full border border-solid px-2 text-[11px] leading-4 border-editor-group-border bg-transparent text-foreground hover:bg-list-hover"

const SECTION_CLASS = "mt-2 text-[10.5px] font-medium uppercase tracking-wider text-description"

/** How often the open form re-checks the workspace, so a fix made in Settings shows without retyping. */
const CHECK_MS = 4000

/** What must be fixed before `name` can run, kept current while the form is open. */
function useWorkspaceCheck(name: string, taskGroupId?: string) {
	const key = JSON.stringify([name, taskGroupId])
	const [checkResult, setCheckResult] = useState<{ key: string; problems: AutomationProblem[] }>()
	const active = useRef<{ sent: number; applied: number }>()
	const onRecheck = useCallback(async () => {
		const state = active.current
		if (!state) return
		const request = ++state.sent
		const problems = await checkAutomation(name, { taskGroupId })
		if (active.current !== state || request <= state.applied) return
		state.applied = request
		setCheckResult((current) =>
			current?.key === key && JSON.stringify(current.problems) === JSON.stringify(problems) ? current : { key, problems },
		)
	}, [key, name, taskGroupId])
	useEffect(() => {
		active.current = { sent: 0, applied: 0 }
		// Keep the last verified result while the host is unavailable.
		const check = () => onRecheck().catch(() => {})
		void check()
		const timer = setInterval(() => void check(), CHECK_MS)
		return () => {
			active.current = undefined
			clearInterval(timer)
		}
	}, [onRecheck])
	return { problems: checkResult?.key === key ? checkResult.problems : [], onRecheck }
}

/** Whether a step fills in `{{name}}` (the start form marks it while that argument is edited). */
function usesArg(step: AutomationStep | undefined, name: string): boolean {
	return !!step && new RegExp(`\\{\\{\\s*${name}\\s*\\}\\}`).test(JSON.stringify(step))
}

/** "2 lines, 1 image, 1 file" for the context line. */
function describeContext(text: string, attachments: { images: number; files: number }): string {
	const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`
	const lines = text.trim() ? text.trim().split("\n").length : 0
	return [
		lines ? plural(lines, "line") : "",
		attachments.images ? plural(attachments.images, "image") : "",
		attachments.files ? plural(attachments.files, "file") : "",
	]
		.filter(Boolean)
		.join(", ")
}

/**
 * The start form above the composer for `/name`: what will run, step by step with its model, so what
 * starts and roughly what it costs is clear before anything does. The arguments are chips in the
 * composer under it, and the text box there holds the run's context. Enter or Run starts it.
 */
const AutomationStartForm: React.FC<AutomationStartFormProps> = ({
	draft,
	focusedArg,
	attachments,
	taskGroupId,
	taskTitle,
	onTrust,
	onViewFile,
	error,
}) => {
	const { modelSettings, taskHistory, navigateToSettings } = useExtensionState()
	const runs = useAutomationRuns()
	const { automation } = draft
	const definition = automation.definition
	const ready = automationDraftValues(draft)
	const values = "values" in ready ? ready.values : draft.values
	const contextSummary = describeContext(draft.context, attachments)
	const placed = placesContext(definition.steps)
	const willRun = describeRun(definition, values, modelSettings, {
		inTask: !!taskGroupId,
		text: draft.context,
		earlierRuns: runs,
		history: taskHistory,
	})
	// Models are checked here; the host checks what only it can see (can a worktree be made?).
	const workspaceCheck = useWorkspaceCheck(automation.name, taskGroupId)
	const workspaceProblems = workspaceCheck.problems.filter((problem) => problem.fix !== "models")
	const autoApproved = willRun.steps.some((step) => step.threads.some((thread) => thread.worktree && thread.mode === "Act"))
	const blocked =
		"reason" in ready
			? ready.reason
			: willRun.problems.length
				? "Fix the steps marked below first"
				: workspaceProblems.length
					? "Fix this first; nothing runs until then"
					: undefined
	const status = !automation.trusted
		? { text: "Trust this version before running it", tone: "error" as const }
		: blocked
			? { text: blocked, tone: "error" as const }
			: { text: "Ready. Enter runs it.", tone: "ok" as const }

	return (
		<div
			aria-label={`Start ${automation.name}`}
			className="mx-3.5 -mb-1 max-h-80 overflow-y-auto rounded-t-xs border border-b-0 border-editor-group-border bg-(--vscode-editorWidget-background) px-2.5 py-2 text-xs"
			data-testid="automation-start-form"
			role="group">
			<div className="flex items-baseline gap-2">
				<span aria-hidden className="codicon codicon-run-all text-[11px]! text-description" />
				<span className="ph-no-capture font-mono font-semibold">{automation.name}</span>
				<span className="min-w-0 flex-1 truncate text-description">
					{automationDisplayName(definition) !== automation.name ? `${automationDisplayName(definition)} · ` : ""}
					{definition.description}
				</span>
				<LinkButton className="shrink-0" onClick={onViewFile} onMouseDown={(event) => event.preventDefault()}>
					View file
				</LinkButton>
			</div>

			{!automation.trusted && (
				<div
					className="mt-1.5 flex flex-wrap items-center gap-2 rounded-xs border border-warning/50 px-2 py-1 text-warning"
					data-testid="automation-untrusted">
					<span className="min-w-0 basis-full">
						This version isn't trusted yet (it's new, or changed since you trusted it). It can start threads and edit
						code, so look at the file first.
					</span>
					<button
						className={CHIP_CLASS}
						onClick={onTrust}
						onMouseDown={(event) => event.preventDefault()}
						type="button">
						Trust this version
					</button>
				</div>
			)}

			<div className={cn(SECTION_CLASS, "flex items-baseline gap-2")}>
				Will run
				<span className="normal-case tracking-normal font-normal">{summarizeRun(willRun)}</span>
			</div>
			<ol className="m-0 mt-1 list-none p-0" data-testid="automation-will-run">
				{willRun.steps.map((step) => (
					<li
						className={cn(
							"mt-0.5",
							step.perItem && "ml-2 border-0 border-l border-solid border-editor-group-border pl-1.5",
						)}
						key={`${step.number}-${step.title}`}>
						<div className="flex items-baseline gap-1.5">
							<span className="w-4 shrink-0 text-right text-description">{step.number || "·"}</span>
							<span className="min-w-0 truncate font-medium">{step.title}</span>
							{step.detail && step.kind !== "each" && (
								<span className="min-w-0 flex-1 truncate text-description">{step.detail}</span>
							)}
							{focusedArg && usesArg(definition.steps[step.number - 1], focusedArg) && (
								<span className="shrink-0 text-link" data-testid={`automation-uses-${step.number}`}>
									uses {focusedArg}
								</span>
							)}
						</div>
						{step.kind === "each" && <div className="ml-5.5 text-description">{step.detail}</div>}
						{step.threads.map((thread) => (
							<div className="ml-5.5 flex min-w-0 items-baseline gap-1.5" key={thread.title}>
								{step.threads.length > 1 && <span className="min-w-0 shrink truncate">{thread.title}</span>}
								<span className={cn("min-w-0 truncate", thread.problem ? "text-error" : "text-description")}>
									{thread.problem ?? thread.model}
								</span>
								{!thread.problem && <span className="shrink-0 text-description">· {thread.mode}</span>}
								{thread.worktreeScope && (
									<span className="shrink-0 text-description">
										·{" "}
										{thread.worktreeScope === "task"
											? "task worktree"
											: thread.worktreeScope === "thread"
												? "own worktree"
												: "your workspace"}
									</span>
								)}
								{thread.problem && (
									<LinkButton
										className="shrink-0"
										onClick={() => navigateToSettings("models")}
										onMouseDown={(event) => event.preventDefault()}>
										Settings › Models
									</LinkButton>
								)}
							</div>
						))}
					</li>
				))}
			</ol>
			<div className="mt-1.5 text-description" data-testid="automation-context">
				{contextSummary ? (
					<>
						<span className="text-foreground">Your context</span> ({contextSummary}){" "}
						{placed ? "goes where the automation puts {{context}}." : "goes with every thread, after its prompt."}
					</>
				) : definition.arguments.length ? (
					"Fill the arguments below. Anything you type in the box under them goes to the run as context."
				) : (
					"Anything you type below goes to the run as context."
				)}
			</div>
			<div className="mt-1 text-description" data-testid="automation-cost">
				{willRun.cost}
				{definition.costLimit ? ` Stops itself at ${formatAutomationCost(definition.costLimit)}.` : ""}
			</div>
			{autoApproved && (
				<div className="mt-1 text-description" data-testid="automation-auto-approve">
					In its worktree, Act steps read and edit files without asking; commands and anything outside it still ask.
				</div>
			)}
			<div className="mt-1 text-description">
				{taskTitle
					? `Runs in this task: ${taskTitle}.`
					: definition.steps[0]?.kind === "task"
						? "Runs in the ticket's task."
						: "Runs in a new task."}{" "}
				Its threads are normal threads: open one and type to step in.
			</div>
			{workspaceProblems.length > 0 && (
				<div className="mt-1.5" data-testid="automation-precheck">
					<ProblemList automation={automation.name} onRecheck={workspaceCheck.onRecheck} problems={workspaceProblems} />
				</div>
			)}
			<div
				className={cn("mt-1.5", error || status.tone === "error" ? "text-error" : "text-success")}
				data-testid="automation-start-status"
				role="status">
				{error ?? status.text}
			</div>
		</div>
	)
}

export default AutomationStartForm
