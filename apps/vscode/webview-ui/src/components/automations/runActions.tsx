import type { AutomationFix, AutomationProblem, AutomationRun } from "@shared/automations"
import { ResumeAutomationRunRequest } from "@shared/proto/cline/automation"
import { StringRequest } from "@shared/proto/cline/common"
import { useCallback, useState } from "react"
import { LinkButton } from "@/components/common/LinkButton"
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

/** The link to where a problem is fixed: Worktrees or Models settings, or the automation in the builder. */
export function FixLink({ fix, automation, className }: { fix: AutomationFix; automation?: string; className?: string }) {
	const { navigateToSettings } = useExtensionState()
	const { automations } = useAutomations()
	const path = automations.find((item) => item.name === automation)?.path
	if (fix === "automation" && !path) return null
	return (
		<LinkButton
			className={className}
			data-testid={`run-fix-${fix}`}
			onClick={() => (fix === "automation" ? openAutomationBuilder({ path }) : navigateToSettings(fix))}
			onMouseDown={(event) => event.preventDefault()}>
			{FIX_LABELS[fix]}
		</LinkButton>
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
 * Retry, Resume from a step, and Run again on a finished run. Each checks the workspace first, so a
 * cause that's still there shows with its fix instead of starting anything.
 */
export function useRunActions(run: AutomationRun) {
	const [busy, setBusy] = useState(false)
	const [problems, setProblems] = useState<AutomationProblem[]>([])
	const send = useCallback(
		async (options: { stepId?: string; fresh?: boolean }) => {
			setBusy(true)
			setProblems([])
			try {
				const found = await checkAutomation(run.automation)
				if (found.length) {
					setProblems(found)
					return
				}
				await AutomationServiceClient.resumeAutomationRun(
					ResumeAutomationRunRequest.create({ runId: run.id, stepId: options.stepId ?? "", fresh: !!options.fresh }),
				)
			} catch (error) {
				setProblems([{ message: error instanceof Error ? error.message : String(error) }])
			} finally {
				setBusy(false)
			}
		},
		[run.automation, run.id],
	)
	return {
		busy,
		problems,
		retry: () => send({}),
		resumeFrom: (stepId: string) => send({ stepId }),
		runAgain: () => send({ fresh: true }),
	}
}
