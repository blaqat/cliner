import {
	type AutomationArgument,
	type AutomationProblem,
	automationDisplayName,
	automationThreads,
	formatAutomationCost,
} from "@shared/automations"
import { parseTypedOptions, setTypedOption, typedFocus } from "@shared/scripts"
import type React from "react"
import { useEffect, useRef, useState } from "react"
import { LinkButton } from "@/components/common/LinkButton"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useAutomationRuns } from "@/hooks/useAutomationRuns"
import { cn } from "@/lib/utils"
import { type AutomationInput, automationInputValues } from "./automationInput"
import { checkAutomation, ProblemList } from "./runActions"
import { describeRun, summarizeRun } from "./willRun"

interface AutomationStartFormProps {
	input: AutomationInput
	/** Replaces the typed arguments; the composer keeps the focus. */
	onChange: (nextOptionsText: string) => void
	/** The run goes into this task (the composer is in it). */
	taskTitle?: string
	/** Ticket keys the task (or thread) is tagged with, offered for ticket arguments. */
	tickets: readonly string[]
	/** Trusts the version on screen (a file someone else changed). */
	onTrust: () => void
	onViewFile: () => void
	/** Why the last Run didn't start. */
	error?: string
}

const KIND_LABELS: Record<AutomationArgument["kind"], string> = {
	text: "text",
	ticket: "ticket",
	branch: "branch",
	choice: "choice",
}

const CHIP_CLASS =
	"cursor-pointer rounded-full border border-solid px-2 text-[11px] leading-4 border-editor-group-border bg-transparent text-foreground hover:bg-list-hover"

const SECTION_CLASS = "mt-2 text-[10.5px] font-medium uppercase tracking-wider text-description"

/** How often the open form re-checks the workspace, so a fix made in Settings shows without retyping. */
const CHECK_MS = 4000

/** What must be fixed before `name` can run, kept current while the form is open. */
function useWorkspaceCheck(name: string) {
	const [checkResult, setCheckResult] = useState<{ name: string; problems: AutomationProblem[] }>()
	const active = useRef<{ name: string; sent: number; applied: number }>()
	const onRecheck = (problems: AutomationProblem[]) => {
		const state = active.current
		if (state?.name !== name) return
		state.applied = state.sent
		setCheckResult({ name, problems })
	}
	useEffect(() => {
		const state = { name, sent: 0, applied: 0 }
		active.current = state
		const check = async () => {
			const request = ++state.sent
			try {
				const problems = await checkAutomation(name)
				if (active.current !== state || request <= state.applied) return
				state.applied = request
				setCheckResult((current) =>
					current?.name === name && JSON.stringify(current.problems) === JSON.stringify(problems)
						? current
						: { name, problems },
				)
			} catch {
				// Keep the last verified result while the host is unavailable.
			}
		}
		void check()
		const timer = setInterval(() => void check(), CHECK_MS)
		return () => {
			active.current = undefined
			clearInterval(timer)
		}
	}, [name])
	return { problems: checkResult?.name === name ? checkResult.problems : [], onRecheck }
}

/**
 * The start form above the composer for `/name`: arguments (typed inline like script options, or
 * clicked), then every step with its model, so what will run and roughly what it costs is clear before
 * anything starts. Enter or Run starts it.
 */
const AutomationStartForm: React.FC<AutomationStartFormProps> = ({
	input,
	onChange,
	taskTitle,
	tickets,
	onTrust,
	onViewFile,
	error,
}) => {
	const { modelSettings, currentBranch, taskHistory, navigateToSettings } = useExtensionState()
	const runs = useAutomationRuns()
	const { automation, options, optionsText } = input
	const definition = automation.definition
	const parsed = parseTypedOptions(optionsText, options)
	const focus = typedFocus(optionsText, options)
	const ready = automationInputValues(input)
	const values =
		"values" in ready ? ready.values : Object.fromEntries(Object.entries(parsed.values).map(([k, v]) => [k, String(v)]))
	const willRun = describeRun(definition, values, modelSettings, {
		inTask: !!taskTitle,
		earlierRuns: runs,
		history: taskHistory,
	})
	// Models are checked here; the host checks what only it can see (can a worktree be made?).
	const workspaceCheck = useWorkspaceCheck(automation.name)
	const workspaceProblems = workspaceCheck.problems.filter((problem) => problem.fix !== "models")
	const autoApproved = automationThreads(definition.steps).some(({ thread }) => thread.worktree && thread.mode === "act")
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
	const set = (name: string, value: string) => onChange(setTypedOption(optionsText, options, name, value))

	const suggestionsFor = (arg: AutomationArgument): string[] => {
		if (arg.kind === "choice") return arg.choices ?? []
		if (arg.kind === "ticket") return [...tickets]
		if (arg.kind === "branch") return currentBranch ? [currentBranch] : []
		return []
	}

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

			{definition.arguments.length > 0 && <div className={SECTION_CLASS}>Arguments</div>}
			{definition.arguments.map((arg) => {
				const value = parsed.values[arg.name]
				const isSet = value !== undefined
				const isCurrent = focus.option?.name === arg.name
				const missing = arg.required && !isSet && !arg.default
				const suggestions = suggestionsFor(arg).filter((choice) => choice !== value)
				return (
					<div
						className={cn(
							"mt-1 rounded-xs border border-solid px-2 py-1",
							isCurrent
								? "border-(--vscode-focusBorder) bg-list-hover"
								: isSet
									? "border-success/40"
									: missing
										? "border-error/40"
										: "border-editor-group-border",
						)}
						data-testid={`automation-arg-${arg.name}`}
						key={arg.name}>
						<div className="flex items-center gap-1.5">
							<span className="font-mono font-semibold">{arg.name}</span>
							<span
								className={cn(
									"rounded-full border border-solid px-1.5 text-[10px] leading-4",
									arg.required ? "border-error/50 text-error" : "border-editor-group-border text-description",
								)}>
								{arg.required ? "required" : "optional"}
							</span>
							<span className="min-w-0 flex-1 truncate text-description">{arg.description}</span>
							<span className="shrink-0 text-description">{KIND_LABELS[arg.kind]}</span>
						</div>
						<div className="mt-0.5 flex flex-wrap items-center gap-1">
							{isSet ? (
								<span className="flex items-center gap-0.5 text-success">
									<span aria-hidden className="codicon codicon-check text-[11px]!" />
									<span className="ph-no-capture">{String(value)}</span>
								</span>
							) : arg.default ? (
								<span className="text-description">default {arg.default}</span>
							) : null}
							{suggestions.map((choice) => (
								<button
									className={CHIP_CLASS}
									data-testid={`automation-arg-${arg.name}-${choice}`}
									key={choice}
									onClick={() => set(arg.name, choice)}
									onMouseDown={(event) => event.preventDefault()}
									type="button">
									{arg.kind === "choice" ? choice : `Use ${choice}`}
								</button>
							))}
							{!isSet && !isCurrent && arg.kind !== "choice" && (
								<LinkButton onClick={() => set(arg.name, "")} onMouseDown={(event) => event.preventDefault()}>
									type a value
								</LinkButton>
							)}
						</div>
					</div>
				)
			})}

			<div className={cn(SECTION_CLASS, "flex items-baseline gap-2")}>
				Will run
				<span className="normal-case tracking-normal font-normal">{summarizeRun(willRun)}</span>
			</div>
			<ol className="m-0 mt-1 list-none p-0" data-testid="automation-will-run">
				{willRun.steps.map((step) => (
					<li className="mt-0.5" key={`${step.number}-${step.title}`}>
						<div className="flex items-baseline gap-1.5">
							<span className="w-4 shrink-0 text-right text-description">{step.number || "·"}</span>
							<span className="min-w-0 truncate font-medium">{step.title}</span>
							{step.detail && <span className="min-w-0 flex-1 truncate text-description">{step.detail}</span>}
						</div>
						{step.threads.map((thread) => (
							<div className="ml-5.5 flex min-w-0 items-baseline gap-1.5" key={thread.title}>
								{step.threads.length > 1 && <span className="min-w-0 shrink truncate">{thread.title}</span>}
								<span className={cn("min-w-0 truncate", thread.problem ? "text-error" : "text-description")}>
									{thread.problem ?? thread.model}
								</span>
								{!thread.problem && <span className="shrink-0 text-description">· {thread.mode}</span>}
								{thread.worktree && (
									<span className="shrink-0 text-description" title="Runs in a new worktree">
										· new worktree
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
			<div className="mt-1.5 text-description" data-testid="automation-cost">
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
