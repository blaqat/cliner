import type { AutomationFix, AutomationProblem, AutomationRun } from "@shared/automations"
import { ResumeAutomationRunRequest } from "@shared/proto/cline/automation"
import { StringRequest } from "@shared/proto/cline/common"
import { useCallback, useState, useSyncExternalStore } from "react"
import { LinkButton } from "@/components/common/LinkButton"
import { threadWorktreeAction, worktreeErrorText } from "@/components/worktrees/useWorktree"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useAutomations } from "@/hooks/useAutomations"
import { AutomationServiceClient } from "@/services/grpc-client"
import { openAutomationBuilder } from "./builderNavigation"
import { FIX_LABELS } from "./runFacts"

export const stopRun = (runId: string) =>
	AutomationServiceClient.stopAutomationRun(StringRequest.create({ value: runId })).catch((error) =>
		console.error("Failed to stop the run:", error),
	)

/** What must be fixed before `/name` can run (worktrees, models); empty when it can. */
export async function checkAutomation(name: string): Promise<AutomationProblem[]> {
	try {
		const response = await AutomationServiceClient.checkAutomationRun(StringRequest.create({ value: name }))
		const parsed = JSON.parse(response.problemsJson || "[]")
		return Array.isArray(parsed) ? (parsed as AutomationProblem[]) : []
	} catch {
		return []
	}
}

/**
 * The link to where a problem is fixed: Worktrees or Models settings, the automation in the builder,
 * or the folder itself (open another, initialize git here, or commit in Source Control).
 */
export function FixLink({ fix, automation, className }: { fix: AutomationFix; automation?: string; className?: string }) {
	const { navigateToSettings } = useExtensionState()
	const { automations } = useAutomations()
	const path = automations.find((item) => item.name === automation)?.path
	if (fix === "automation" && !path) return null
	if (fix === "repository") return <RepositoryFix automation={automation} className={className} />
	const onClick =
		fix === "automation"
			? () => openAutomationBuilder({ path })
			: fix === "folder"
				? () => void threadWorktreeAction("openFolder")
				: fix === "commit"
					? () => void threadWorktreeAction("openSourceControl")
					: () => navigateToSettings(fix)
	return (
		<LinkButton
			className={className}
			data-testid={`run-fix-${fix}`}
			onClick={onClick}
			onMouseDown={(event) => event.preventDefault()}>
			{FIX_LABELS[fix]}
		</LinkButton>
	)
}

/**
 * The folder isn't a git repository: open the right folder, or make this one a repository. git init
 * runs only on the click, then the automation is checked again and says what's left (or that it's ready).
 */
function RepositoryFix({ automation, className }: { automation?: string; className?: string }) {
	const [result, setResult] = useState<{ busy?: boolean; left?: AutomationProblem[]; error?: string }>({})
	const initialize = async () => {
		setResult({ busy: true })
		try {
			await threadWorktreeAction("initRepository")
			setResult({ left: automation ? await checkAutomation(automation) : [] })
		} catch (error) {
			setResult({ error: `Couldn't initialize git: ${worktreeErrorText(error)}` })
		}
	}
	const left = result.left?.find((problem) => problem.fix !== "repository") ?? result.left?.[0]
	return (
		<>
			<span className={className} data-testid="run-fix-repository">
				<LinkButton
					data-testid="run-fix-open-folder"
					onClick={() => void threadWorktreeAction("openFolder")}
					onMouseDown={(event) => event.preventDefault()}>
					{FIX_LABELS.repository}
				</LinkButton>
				{" · "}
				<LinkButton
					data-testid="run-fix-git-init"
					disabled={result.busy}
					onClick={() => void initialize()}
					onMouseDown={(event) => event.preventDefault()}>
					{result.busy ? "Initializing…" : "Initialize git here"}
				</LinkButton>
			</span>
			{/* Its own line under the links: the sentence it answers is still above. */}
			{result.left && !left && (
				<span className="block text-description" data-testid="run-fix-ready">
					Git is set up. Retry the step.
				</span>
			)}
			{left && (
				<span className="block text-description" data-testid="run-fix-left">
					Git is set up, but {left.message.replace(/^.*?, but /, "")}{" "}
					{left.fix && left.fix !== "repository" && (
						<FixLink automation={automation} className="whitespace-nowrap" fix={left.fix} />
					)}
				</span>
			)}
			{result.error && (
				<span className="block" data-testid="run-fix-error">
					{result.error}
				</span>
			)}
		</>
	)
}

/** Problems with their fix links, one per line. */
export function ProblemList({ problems, automation }: { problems: readonly AutomationProblem[]; automation?: string }) {
	return (
		<ul className="m-0 list-none p-0" data-testid="run-problems" role="alert">
			{problems.map((problem) => (
				<li className="text-error" key={problem.message}>
					{problem.message}{" "}
					{problem.fix && <FixLink automation={automation} className="whitespace-nowrap" fix={problem.fix} />}
				</li>
			))}
		</ul>
	)
}

/**
 * Runs with a Retry, Resume or Run again on its way, shared by every place that offers one (the task
 * page's run block and a thread's run bar), so a second click anywhere waits for the first. Each holds
 * the run as it looked at the click: a resumed run counts as starting until the run stream shows it
 * changed (live, or ended again), since a click before that would only be refused.
 */
const starting = new Map<string, string>()
const startingListeners = new Set<() => void>()
const startingTimers = new Map<string, ReturnType<typeof setTimeout>>()
/** At most this long, in case the run stream never reports the change. */
const STARTED_GRACE_MS = 10_000
const runShape = (run: AutomationRun) => `${run.status}|${run.resumedAt ?? ""}|${run.endedAt ?? ""}`
function setStarting(runId: string, shape: string | undefined) {
	clearTimeout(startingTimers.get(runId))
	startingTimers.delete(runId)
	if (shape === starting.get(runId)) return
	if (shape === undefined) starting.delete(runId)
	else starting.set(runId, shape)
	for (const listener of startingListeners) listener()
}
function subscribeStarting(listener: () => void) {
	startingListeners.add(listener)
	return () => {
		startingListeners.delete(listener)
	}
}

/** Test seam: forget runs left starting by an earlier test. */
export function clearRunStartsForTest() {
	for (const runId of [...starting.keys()]) setStarting(runId, undefined)
}

/**
 * Retry, Resume from a step, and Run again on a finished run. Each checks the workspace first, so a
 * cause that's still there shows with its fix instead of starting anything. While one is starting,
 * every Retry and Resume for that run is disabled and says so.
 */
export function useRunActions(run: AutomationRun) {
	const shape = runShape(run)
	const busy = useSyncExternalStore(subscribeStarting, () => starting.get(run.id) === shape)
	const [problems, setProblems] = useState<AutomationProblem[]>([])
	const send = useCallback(
		async (options: { stepId?: string; fresh?: boolean }) => {
			// Checked synchronously: a double click lands before React re-renders the disabled button.
			if (starting.get(run.id) === shape) return
			setStarting(run.id, shape)
			setProblems([])
			try {
				const found = await checkAutomation(run.automation)
				if (found.length) {
					setProblems(found)
					setStarting(run.id, undefined)
					return
				}
				await AutomationServiceClient.resumeAutomationRun(
					ResumeAutomationRunRequest.create({ runId: run.id, stepId: options.stepId ?? "", fresh: !!options.fresh }),
				)
				// Run again makes a new run, which shows up on its own; this one is free again.
				if (options.fresh) setStarting(run.id, undefined)
				else
					startingTimers.set(
						run.id,
						setTimeout(() => setStarting(run.id, undefined), STARTED_GRACE_MS),
					)
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				// Another window (or a click before this one) already got it going: not a failure.
				if (!/already running/i.test(message)) setProblems([{ message }])
				setStarting(run.id, undefined)
			}
		},
		[run.automation, run.id, shape],
	)
	return {
		busy,
		problems,
		retry: () => send({}),
		resumeFrom: (stepId: string) => send({ stepId }),
		runAgain: () => send({ fresh: true }),
	}
}
