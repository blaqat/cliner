import type { AutomationFix, AutomationProblem, AutomationRun } from "@shared/automations"
import { CheckAutomationRunRequest, ResumeAutomationRunRequest } from "@shared/proto/cline/automation"
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
export async function checkAutomation(
	name: string,
	options: Pick<CheckAutomationRunRequest, "taskGroupId" | "resume"> = {},
): Promise<AutomationProblem[]> {
	const response = await AutomationServiceClient.checkAutomationRun(
		CheckAutomationRunRequest.create({ value: name, ...options }),
	)
	const parsed = JSON.parse(response.problemsJson || "[]")
	if (!Array.isArray(parsed)) throw new Error("Couldn't check the workspace.")
	return parsed as AutomationProblem[]
}

/**
 * The link to where a problem is fixed: Worktrees or Models settings, the automation in the builder,
 * or the folder itself (open another, initialize git here, or commit in Source Control).
 */
function FixLink({ fix, automation }: { fix: Exclude<AutomationFix, "repository">; automation: string }) {
	const { navigateToSettings } = useExtensionState()
	const { automations } = useAutomations()
	const path = automations.find((item) => item.name === automation)?.path
	if (fix === "automation" && !path) return null
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
			className="whitespace-nowrap"
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
function RepositoryFix({ onRecheck }: Pick<ProblemDetailsProps, "onRecheck">) {
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState("")
	const initialize = async () => {
		setBusy(true)
		setError("")
		try {
			try {
				await threadWorktreeAction("initRepository")
			} catch (error) {
				setError(`Couldn't initialize git: ${worktreeErrorText(error)}`)
				return
			}
			await onRecheck()
		} catch {
			setError("Git is initialized. Couldn't re-check the workspace.")
		} finally {
			setBusy(false)
		}
	}
	return (
		<>
			<span data-testid="run-fix-repository">
				<LinkButton
					className="whitespace-nowrap"
					data-testid="run-fix-open-folder"
					onClick={() => void threadWorktreeAction("openFolder")}
					onMouseDown={(event) => event.preventDefault()}>
					{FIX_LABELS.repository}
				</LinkButton>
				{" · "}
				<LinkButton
					className="whitespace-nowrap"
					data-testid="run-fix-git-init"
					disabled={busy}
					onClick={() => void initialize()}
					onMouseDown={(event) => event.preventDefault()}>
					{busy ? "Initializing…" : "Initialize git here"}
				</LinkButton>
			</span>
			{error && (
				<span className="block" data-testid="run-fix-error">
					{error}
				</span>
			)}
		</>
	)
}

interface ProblemDetailsProps {
	automation: string
	onRecheck: () => Promise<void>
}

export function ProblemDetails({ problem, automation, onRecheck }: ProblemDetailsProps & { problem: AutomationProblem }) {
	return (
		<>
			{problem.message}{" "}
			{problem.fix === "repository" ? (
				<RepositoryFix onRecheck={onRecheck} />
			) : problem.fix ? (
				<FixLink automation={automation} fix={problem.fix} />
			) : null}
		</>
	)
}

/** Problems with their fix links, one per line. */
export function ProblemList({
	problems,
	automation,
	onRecheck,
}: ProblemDetailsProps & { problems: readonly AutomationProblem[] }) {
	return (
		<ul className="m-0 list-none p-0" data-testid="run-problems" role="alert">
			{problems.map((problem) => (
				<li className="text-error" key={problem.message}>
					<ProblemDetails automation={automation} onRecheck={onRecheck} problem={problem} />
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
	const [lastCheck, setLastCheck] = useState<{
		shape: string
		problems: AutomationProblem[]
		ready?: boolean
		resume?: ResumeAutomationRunRequest
	}>()
	const check = lastCheck?.shape === shape ? lastCheck : undefined
	const onRecheck = async () => {
		const resume = check?.resume ?? ResumeAutomationRunRequest.create({ runId: run.id })
		const problems = await checkAutomation(run.automation, { resume })
		setLastCheck({ shape, problems, ready: problems.length === 0, resume })
	}
	const send = useCallback(
		async (options: { stepId?: string; fresh?: boolean }) => {
			// Checked synchronously: a double click lands before React re-renders the disabled button.
			if (starting.get(run.id) === shape) return
			setStarting(run.id, shape)
			const resume = ResumeAutomationRunRequest.create({
				runId: run.id,
				stepId: options.stepId ?? "",
				fresh: !!options.fresh,
			})
			try {
				const found = await checkAutomation(run.automation, { resume })
				setLastCheck({ shape, problems: found, resume })
				if (found.length) {
					setStarting(run.id, undefined)
					return
				}
				await AutomationServiceClient.resumeAutomationRun(resume)
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
				if (!/already running/i.test(message)) setLastCheck({ shape, problems: [{ message }], resume })
				setStarting(run.id, undefined)
			}
		},
		[run.automation, run.id, shape],
	)
	return {
		busy,
		problems: check?.problems,
		ready: check?.ready,
		onRecheck,
		retry: () => send({}),
		resumeFrom: (stepId: string) => send({ stepId }),
		runAgain: () => send({ fresh: true }),
	}
}
