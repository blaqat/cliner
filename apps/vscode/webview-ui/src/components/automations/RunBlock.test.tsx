import type { AutomationRun } from "@shared/automations"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { setAutomationRunsForTest } from "@/hooks/useAutomationRuns"
import { AutomationRunBar } from "./AutomationRunBar"
import { clearRunFoldsForTest, RunBlock } from "./RunBlock"
import { clearRunStartsForTest } from "./runActions"

const mocks = vi.hoisted(() => ({
	stop: vi.fn(),
	answer: vi.fn(),
	resume: vi.fn(),
	check: vi.fn(),
	settings: vi.fn(),
	navigate: vi.fn(),
	worktreeAction: vi.fn(),
	history: [] as unknown[],
}))

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({ taskHistory: mocks.history, navigateToSettings: mocks.settings }),
}))
vi.mock("@/components/navigation/NavigationHistoryContext", () => ({
	useNavigationHistory: () => ({ navigate: mocks.navigate }),
}))
vi.mock("@/services/grpc-client", () => ({
	AutomationServiceClient: {
		stopAutomationRun: (request: unknown) => mocks.stop(request),
		answerAutomationCheckpoint: (request: unknown) => mocks.answer(request),
		resumeAutomationRun: (request: unknown) => mocks.resume(request),
		checkAutomationRun: (request: unknown) => mocks.check(request),
		listAutomations: vi.fn(async () => ({ automations: [] })),
		subscribeToAutomationRuns: vi.fn(() => () => {}),
	},
	WorktreeServiceClient: {
		threadWorktreeAction: (request: { action: string }) => mocks.worktreeAction(request),
	},
}))

const thread = (id: string, threadId: string | undefined, status: string, extra = {}) => ({
	id,
	threadId,
	title: id === "a" ? "Plan A" : id === "b" ? "Plan B" : "Research",
	model: "Opus 5.5",
	level: "high",
	mode: "ask" as const,
	worktree: false,
	status: status as never,
	...extra,
})

function waitingRun(): AutomationRun {
	return {
		id: "run-1",
		automation: "ticket-to-pr",
		title: "Ticket to PR",
		values: { ticket: "P-1" },
		taskGroupId: "g1",
		status: "waiting",
		startedAt: 0,
		steps: [
			{
				id: "research",
				kind: "thread",
				title: "Research P-1",
				status: "done",
				threads: [thread("r", "t1", "done", { reply: "Gateway 502s" })],
			},
			{
				id: "plan",
				kind: "together",
				title: "Plan",
				status: "done",
				threads: [thread("a", "t2", "done"), thread("b", "t3", "done")],
			},
			{
				id: "pick",
				kind: "checkpoint",
				title: "Pick a plan",
				status: "waiting",
				threads: [],
				question: "Which plan?",
				choices: ["Plan A", "Plan B"],
			},
			{ id: "build", kind: "thread", title: "Build", status: "pending", threads: [thread("build", undefined, "pending")] },
		],
	}
}

/** The run failed at Build: its worktree couldn't be made. */
function failedRun(): AutomationRun {
	const run = waitingRun()
	run.status = "failed"
	run.endedAt = 5 * 60_000
	run.steps[2] = { ...run.steps[2], status: "done", choice: "Plan A" }
	run.steps[3] = {
		...run.steps[3],
		status: "failed",
		fix: "worktrees",
		threads: [
			thread("build", undefined, "failed", {
				error: "Couldn't make its worktree: this folder isn't a git repository.",
				fix: "worktrees",
				worktree: true,
				mode: "act",
			}),
		],
	}
	return run
}

beforeEach(() => {
	mocks.stop.mockReset().mockResolvedValue({})
	mocks.answer.mockReset().mockResolvedValue({})
	mocks.resume.mockReset().mockResolvedValue({})
	mocks.check.mockReset().mockResolvedValue({ problemsJson: "[]" })
	mocks.settings.mockReset()
	mocks.navigate.mockReset()
	mocks.worktreeAction.mockReset().mockResolvedValue({ json: "{}" })
	clearRunStartsForTest()
	clearRunFoldsForTest()
	mocks.history = [
		{ id: "t1", totalCost: 0.1 },
		{ id: "t2", totalCost: 0.2 },
	]
})

describe("RunBlock", () => {
	it("shows each step once, with its threads and replies; time and cost live in its header", () => {
		render(<RunBlock now={4 * 60_000} onOpenThread={vi.fn()} run={waitingRun()} statuses={{}} />)
		const block = screen.getByTestId("run-block-run-1")
		expect(screen.getByTestId("run-status-run-1")).toHaveTextContent("Waiting for you")
		expect(block).toHaveTextContent("4 min · $0.30")
		// A finished step folds once a later one has started; unfolding shows its threads and replies.
		expect(screen.queryByTestId("run-thread-r")).not.toBeInTheDocument()
		fireEvent.click(screen.getByTestId("run-step-toggle-research"))
		expect(screen.getByTestId("run-thread-r")).toHaveTextContent("Gateway 502s")
		// A single thread's title is the step's: it isn't said twice.
		expect(screen.getByTestId("run-step-research").textContent?.match(/Research P-1/g)).toHaveLength(1)
		expect(screen.getByTestId("run-step-plan")).toHaveTextContent("2 together")
		// A step that hasn't started doesn't list its threads yet.
		expect(screen.queryByTestId("run-thread-build")).not.toBeInTheDocument()
	})

	it("shows a sub-cent run cost and limit in the header", () => {
		mocks.history = [{ id: "t1", totalCost: 0.00054 }]
		render(<RunBlock now={4 * 60_000} onOpenThread={vi.fn()} run={{ ...waitingRun(), costLimit: 0.001 }} statuses={{}} />)
		expect(screen.getByTestId("run-block-run-1")).toHaveTextContent("4 min · $0.00054 of $0.001")
	})

	it("answers the Ask you step and opens a choice's thread to read it", () => {
		const onOpenThread = vi.fn()
		render(<RunBlock onOpenThread={onOpenThread} run={waitingRun()} statuses={{}} />)
		const checkpoint = screen.getByTestId("run-checkpoint-pick")
		expect(checkpoint).toHaveTextContent("Waiting for you: Which plan?")
		fireEvent.click(within(checkpoint).getAllByRole("button", { name: "Read" })[1])
		expect(onOpenThread).toHaveBeenCalledWith("t3")
		fireEvent.click(within(checkpoint).getByRole("button", { name: "Plan A" }))
		expect(mocks.answer).toHaveBeenCalledWith(expect.objectContaining({ runId: "run-1", stepId: "pick", choice: "Plan A" }))
	})

	it("says what a waiting thread needs, with a jump to it, and stops a live run", () => {
		const run = waitingRun()
		run.status = "waiting"
		run.steps[2].status = "done"
		run.steps[3] = {
			...run.steps[3],
			status: "running",
			threads: [thread("build", "t4", "waiting", { waitingOn: "Approve a command: npm test" })],
		}
		const onOpenThread = vi.fn()
		render(<RunBlock onOpenThread={onOpenThread} run={run} statuses={{}} />)
		const waiting = screen.getByTestId("run-waiting-build")
		expect(waiting).toHaveTextContent("Waiting for you: Approve a command: npm test")
		fireEvent.click(within(waiting).getByRole("button", { name: "Go to it" }))
		expect(onOpenThread).toHaveBeenCalledWith("t4")
		fireEvent.click(screen.getByTestId("run-stop-run-1"))
		expect(mocks.stop).toHaveBeenCalledWith(expect.objectContaining({ value: "run-1" }))
	})

	it("says why a step failed once, links to the fix, and retries it after checking", async () => {
		render(<RunBlock onOpenThread={vi.fn()} run={failedRun()} statuses={{}} />)
		expect(screen.getByTestId("run-status-run-1")).toHaveTextContent("Failed at step 4")
		expect(screen.getByTestId("run-block-run-1").textContent?.match(/isn't a git repository/g)).toHaveLength(1)
		fireEvent.click(screen.getByTestId("run-fix-worktrees"))
		expect(mocks.settings).toHaveBeenCalledWith("worktrees")

		// Still broken: the check says so and nothing resumes.
		mocks.check.mockResolvedValueOnce({
			problemsJson: JSON.stringify([
				{ message: "“Build” runs in a new worktree, but worktrees are off.", fix: "worktrees" },
			]),
		})
		fireEvent.click(screen.getByTestId("run-retry-run-1"))
		expect(await screen.findByTestId("run-problems")).toHaveTextContent("worktrees are off")
		expect(mocks.resume).not.toHaveBeenCalled()

		// Fixed: Retry resumes the failed step.
		fireEvent.click(screen.getByTestId("run-retry-run-1"))
		await waitFor(() =>
			expect(mocks.resume).toHaveBeenCalledWith(expect.objectContaining({ runId: "run-1", stepId: "", fresh: false })),
		)
	})

	it("goes back to an earlier step, or runs again fresh", async () => {
		const { rerender } = render(<RunBlock onOpenThread={vi.fn()} run={failedRun()} statuses={{}} />)
		fireEvent.click(screen.getByTestId("run-resume-from-run-1"))
		fireEvent.change(screen.getByTestId("run-resume-step-run-1"), { target: { value: "plan" } })
		fireEvent.click(screen.getByRole("button", { name: "Go on from here" }))
		await waitFor(() => expect(mocks.resume).toHaveBeenCalledWith(expect.objectContaining({ stepId: "plan" })))
		// The resumed run went and failed again; its actions are back.
		rerender(<RunBlock onOpenThread={vi.fn()} run={{ ...failedRun(), resumedAt: 1 }} statuses={{}} />)
		fireEvent.click(screen.getByTestId("run-again-run-1"))
		await waitFor(() => expect(mocks.resume).toHaveBeenCalledWith(expect.objectContaining({ fresh: true })))
	})

	it.each([
		"task page",
		"thread run bar",
	])("replaces stale git recovery guidance on the %s after initializing", async (where) => {
		const run = failedRun()
		run.steps[3] = {
			...run.steps[3],
			fix: "repository",
			threads: [
				{
					...run.steps[3].threads[0],
					error: "Couldn't make its worktree: this folder isn't a git repository. Open the repository's folder, or initialize git here.",
					fix: "repository",
				},
			],
		}
		setAutomationRunsForTest([run])
		render(
			where === "task page" ? (
				<RunBlock onOpenThread={vi.fn()} run={run} statuses={{}} />
			) : (
				<AutomationRunBar taskGroupId="g1" threadId="t1" />
			),
		)
		const block = screen.getByTestId(where === "task page" ? "run-block-run-1" : "automation-run-bar")
		expect(block).toHaveTextContent("isn't a git repository")
		fireEvent.click(within(block).getByTestId("run-fix-open-folder"))
		expect(mocks.worktreeAction).toHaveBeenCalledWith(expect.objectContaining({ action: "openFolder" }))
		// git init only runs on its own click.
		expect(mocks.worktreeAction).not.toHaveBeenCalledWith(expect.objectContaining({ action: "initRepository" }))

		mocks.check.mockResolvedValueOnce({
			problemsJson: JSON.stringify([
				{
					message:
						"“Build” runs in a new worktree, but the repository has no commits yet. Make a first commit in Source Control.",
					fix: "commit",
					stepId: "build",
				},
			]),
		})
		fireEvent.click(within(block).getByTestId("run-fix-git-init"))
		await waitFor(() =>
			expect(mocks.worktreeAction).toHaveBeenCalledWith(expect.objectContaining({ action: "initRepository" })),
		)
		const commit = await within(block).findByTestId("run-fix-commit")
		expect(block).toHaveTextContent("the repository has no commits yet.")
		expect(block).not.toHaveTextContent("isn't a git repository")
		expect(within(block).queryByTestId("run-fix-git-init")).not.toBeInTheDocument()
		expect(within(block).queryByTestId("run-fix-open-folder")).not.toBeInTheDocument()
		fireEvent.click(commit)
		expect(mocks.worktreeAction).toHaveBeenCalledWith(expect.objectContaining({ action: "openSourceControl" }))

		const retry = within(block).getByTestId(where === "task page" ? "run-retry-run-1" : "automation-run-bar-retry")
		fireEvent.click(retry)
		await waitFor(() => expect(mocks.resume).toHaveBeenCalledTimes(1))
		expect(block).not.toHaveTextContent("the repository has no commits yet.")
	})

	it("replaces the blocked resume notice after initializing git", async () => {
		const run = failedRun()
		run.status = "stopped"
		run.steps[3] = { ...run.steps[3], status: "stopped", fix: undefined, threads: [thread("build", undefined, "stopped")] }
		mocks.check
			.mockResolvedValueOnce({ problemsJson: '[{"message":"This folder is not a git repository.","fix":"repository"}]' })
			.mockResolvedValueOnce({ problemsJson: '[{"message":"The repository has no commits yet.","fix":"commit"}]' })
		render(<RunBlock defaultOpen onOpenThread={vi.fn()} run={run} statuses={{}} />)
		fireEvent.click(screen.getByTestId("run-retry-run-1"))
		const problems = await screen.findByTestId("run-problems")
		expect(problems).toHaveTextContent("This folder is not a git repository.")
		fireEvent.click(within(problems).getByTestId("run-fix-git-init"))
		expect(await within(problems).findByTestId("run-fix-commit")).toBeVisible()
		expect(problems).toHaveTextContent("The repository has no commits yet.")
		expect(problems).not.toHaveTextContent("This folder is not a git repository.")
		expect(within(problems).queryByTestId("run-fix-git-init")).not.toBeInTheDocument()
	})

	it("disables Retry everywhere while a resume is starting, until the run reports it", async () => {
		let release: () => void = () => {}
		mocks.check.mockImplementationOnce(() => new Promise((resolve) => (release = () => resolve({ problemsJson: "[]" }))))
		setAutomationRunsForTest([failedRun()])
		const { rerender } = render(
			<>
				<RunBlock onOpenThread={vi.fn()} run={failedRun()} statuses={{}} />
				<AutomationRunBar taskGroupId="g1" threadId="t1" />
			</>,
		)
		fireEvent.click(screen.getByTestId("run-retry-run-1"))
		fireEvent.click(screen.getByTestId("run-retry-run-1"))
		fireEvent.click(screen.getByTestId("automation-run-bar-retry"))
		expect(screen.getByTestId("run-retry-run-1")).toBeDisabled()
		expect(screen.getByTestId("automation-run-bar-retry")).toBeDisabled()
		expect(screen.getByTestId("run-starting-run-1")).toHaveTextContent("Starting the run")
		release()
		await waitFor(() => expect(mocks.resume).toHaveBeenCalledTimes(1))
		// Resumed, but the run stream hasn't said so yet: a click now would only be refused.
		expect(screen.getByTestId("run-retry-run-1")).toBeDisabled()
		fireEvent.click(screen.getByTestId("run-retry-run-1"))
		expect(mocks.resume).toHaveBeenCalledTimes(1)
		// It failed again: Retry is back.
		rerender(<RunBlock onOpenThread={vi.fn()} run={{ ...failedRun(), resumedAt: 1 }} statuses={{}} />)
		expect(screen.getByTestId("run-retry-run-1")).toBeEnabled()
	})

	it("says nothing went wrong when another click already got the run going", async () => {
		mocks.resume.mockRejectedValueOnce(new Error("That run is already running."))
		render(<RunBlock onOpenThread={vi.fn()} run={failedRun()} statuses={{}} />)
		fireEvent.click(screen.getByTestId("run-retry-run-1"))
		await waitFor(() => expect(mocks.resume).toHaveBeenCalled())
		await waitFor(() => expect(screen.getByTestId("run-retry-run-1")).toBeEnabled())
		expect(screen.queryByTestId("run-problems")).not.toBeInTheDocument()
	})

	it("folds a finished run to one line", () => {
		const run = { ...waitingRun(), status: "done" as const, endedAt: 60_000 }
		render(<RunBlock defaultOpen={false} onOpenThread={vi.fn()} run={run} statuses={{}} />)
		expect(screen.queryByTestId("run-steps-run-1")).not.toBeInTheDocument()
		fireEvent.click(screen.getByRole("button", { name: /Ticket to PR/ }))
		expect(screen.getByTestId("run-steps-run-1")).toBeInTheDocument()
	})

	it("starts a failed run expanded and lets you fold and unfold it", () => {
		render(<RunBlock defaultOpen={false} onOpenThread={vi.fn()} run={failedRun()} statuses={{}} />)
		const header = screen.getByRole("button", { name: /Ticket to PR/ })
		const steps = () => screen.queryByTestId("run-steps-run-1")
		expect(steps()).toBeInTheDocument()
		fireEvent.click(header)
		expect(steps()).not.toBeInTheDocument()
		fireEvent.click(header)
		expect(steps()).toBeInTheDocument()
	})

	it("folds a live run; the folded line keeps its status, step, Stop and what it waits on", () => {
		const { rerender } = render(<RunBlock onOpenThread={vi.fn()} run={waitingRun()} statuses={{}} />)
		const header = screen.getByTestId("run-toggle-run-1")
		expect(header).toHaveAttribute("aria-expanded", "true")
		expect(header).toHaveAttribute("title", "Fold")
		fireEvent.click(header)
		expect(header).toHaveAttribute("aria-expanded", "false")
		expect(header).toHaveAttribute("title", "Unfold")
		expect(screen.queryByTestId("run-steps-run-1")).not.toBeInTheDocument()
		expect(screen.getByTestId("run-status-run-1")).toHaveTextContent("Waiting for you")
		expect(screen.getByTestId("run-stop-run-1")).toBeInTheDocument()
		// The Ask you step is answered here: Show unfolds the run to it.
		expect(screen.getByTestId("run-folded-need-run-1")).toHaveTextContent("Pick: Which plan?")
		fireEvent.click(within(screen.getByTestId("run-folded-need-run-1")).getByRole("button", { name: "Show" }))
		expect(screen.getByTestId("run-checkpoint-pick")).toBeInTheDocument()

		// Running with nothing to answer: the folded line says which step it's on.
		const running = waitingRun()
		running.status = "running"
		running.steps[2] = { ...running.steps[2], status: "done", choice: "Plan A" }
		running.steps[3] = { ...running.steps[3], status: "running", threads: [thread("build", "t4", "running")] }
		rerender(<RunBlock onOpenThread={vi.fn()} run={running} statuses={{}} />)
		fireEvent.click(screen.getByTestId("run-toggle-run-1"))
		expect(screen.getByTestId("run-folded-step-run-1")).toHaveTextContent("Step 4 of 4: Build")
	})

	it("sends you to a thread that needs an answer, and to the task page for missing outputs", () => {
		const onOpenThread = vi.fn()
		const run = waitingRun()
		run.steps[2] = { ...run.steps[2], status: "done", choice: "Plan A" }
		run.steps[3] = {
			...run.steps[3],
			status: "running",
			threads: [thread("build", "t4", "waiting", { waitingOn: "Approve an edit to a.ts" })],
		}
		const { rerender } = render(<RunBlock onOpenThread={onOpenThread} run={run} statuses={{}} />)
		fireEvent.click(screen.getByTestId("run-toggle-run-1"))
		fireEvent.click(within(screen.getByTestId("run-folded-need-run-1")).getByRole("button", { name: "Go to it" }))
		expect(onOpenThread).toHaveBeenCalledWith("t4")

		run.steps[3].threads = [
			thread("build", "t4", "waiting", { waitingOn: "Missing outputs: summary", missingOutputs: ["summary"] }),
		]
		rerender(<RunBlock onOpenThread={onOpenThread} run={{ ...run }} statuses={{}} />)
		const need = screen.getByTestId("run-folded-need-run-1")
		expect(need).toHaveTextContent("Missing outputs: summary")
		fireEvent.click(within(need).getByRole("button", { name: "Show" }))
		expect(screen.getByRole("button", { name: "Continue without" })).toBeInTheDocument()
	})

	it("folds each step: finished ones once a later one starts, keeping its outputs count and your choices", () => {
		const run = waitingRun()
		run.steps[0].threads[0].outputs = [
			{ name: "findings", firstLine: "Gateway 502s" },
			{ name: "links", firstLine: "a, b" },
		]
		const { rerender } = render(<RunBlock onOpenThread={vi.fn()} run={run} statuses={{}} />)
		const research = screen.getByTestId("run-step-toggle-research")
		expect(research).toHaveAttribute("aria-expanded", "false")
		expect(research).toHaveAttribute("title", "Unfold")
		expect(screen.getByTestId("run-step-outputs-research")).toHaveTextContent("2 outputs")
		// The waiting step is open; a step that hasn't started has nothing to fold.
		expect(screen.getByTestId("run-step-toggle-pick")).toHaveAttribute("aria-expanded", "true")
		expect(screen.queryByTestId("run-step-toggle-build")).not.toBeInTheDocument()

		fireEvent.click(research)
		fireEvent.click(screen.getByTestId("run-step-toggle-pick"))
		expect(screen.getByText("findings")).toBeInTheDocument()
		expect(screen.queryByTestId("run-checkpoint-pick")).not.toBeInTheDocument()
		// A folded step that needs you says so on its line.
		expect(screen.getByTestId("run-step-needs-pick")).toHaveTextContent("needs you")

		// A streamed update keeps both choices.
		rerender(<RunBlock now={9_000} onOpenThread={vi.fn()} run={{ ...run, steps: [...run.steps] }} statuses={{}} />)
		expect(screen.getByTestId("run-step-toggle-research")).toHaveAttribute("aria-expanded", "true")
		expect(screen.getByTestId("run-step-toggle-pick")).toHaveAttribute("aria-expanded", "false")
	})

	it("shows a finished run's last step open and the earlier ones folded", () => {
		const run = failedRun()
		run.status = "done"
		run.steps[3] = { ...run.steps[3], status: "done", threads: [thread("build", "t4", "done", { reply: "Shipped" })] }
		render(<RunBlock defaultOpen onOpenThread={vi.fn()} run={run} statuses={{}} />)
		expect(screen.getByTestId("run-step-toggle-build")).toHaveAttribute("aria-expanded", "true")
		expect(screen.getByTestId("run-step-toggle-research")).toHaveAttribute("aria-expanded", "false")
		expect(screen.getByTestId("run-step-toggle-plan")).toHaveAttribute("aria-expanded", "false")
	})

	it("keeps the run's fold when a live run ends", () => {
		const { rerender } = render(<RunBlock defaultOpen={false} onOpenThread={vi.fn()} run={waitingRun()} statuses={{}} />)
		expect(screen.getByTestId("run-steps-run-1")).toBeInTheDocument()
		// Watched it finish: it stays open.
		rerender(<RunBlock defaultOpen={false} onOpenThread={vi.fn()} run={failedRun()} statuses={{}} />)
		const done = { ...failedRun(), status: "done" as const }
		rerender(<RunBlock defaultOpen={false} onOpenThread={vi.fn()} run={done} statuses={{}} />)
		expect(screen.getByTestId("run-steps-run-1")).toBeInTheDocument()
		fireEvent.click(screen.getByTestId("run-toggle-run-1"))
		rerender(<RunBlock defaultOpen={false} onOpenThread={vi.fn()} run={{ ...done, endedAt: 99 }} statuses={{}} />)
		expect(screen.queryByTestId("run-steps-run-1")).not.toBeInTheDocument()
	})
})

describe("AutomationRunBar", () => {
	it("in a run's thread: says which step it's on and stops; no step list or cost (the task page has those)", () => {
		const run = waitingRun()
		run.status = "running"
		run.steps[2].status = "done"
		run.steps[3] = { ...run.steps[3], status: "running", threads: [thread("build", "t4", "running")] }
		setAutomationRunsForTest([run])
		const { unmount } = render(<AutomationRunBar onOpenTaskGroup={vi.fn()} threadId="t4" />)
		const bar = screen.getByTestId("automation-run-bar")
		expect(screen.getByTestId("automation-run-bar-status")).toHaveTextContent("Step 4 of 4: Build")
		expect(bar).toHaveTextContent("This thread is step 4 of 4")
		expect(bar).not.toHaveTextContent("$")
		fireEvent.click(screen.getByTestId("automation-run-bar-stop"))
		expect(mocks.stop).toHaveBeenCalled()
		unmount()
		// In a thread whose step already finished, typing there doesn't step in anymore.
		render(<AutomationRunBar onOpenTaskGroup={vi.fn()} threadId="t2" />)
		expect(screen.getByTestId("automation-run-bar")).not.toHaveTextContent("This thread is step")
	})

	it("says what the run is waiting for and jumps to it", () => {
		const run = waitingRun()
		run.steps[2].status = "done"
		run.steps[3] = {
			...run.steps[3],
			status: "running",
			threads: [thread("build", "t4", "waiting", { waitingOn: "Approve an edit to src/a.ts" })],
		}
		setAutomationRunsForTest([run])
		render(<AutomationRunBar onOpenTaskGroup={vi.fn()} taskGroupId="g1" threadId="t1" />)
		expect(screen.getByTestId("automation-run-bar-status")).toHaveTextContent("Waiting for you: Approve an edit to src/a.ts")
		fireEvent.click(screen.getByTestId("automation-run-bar-go"))
		expect(mocks.navigate).toHaveBeenCalledWith({ kind: "thread", id: "t4" })
	})

	it("after a failure: why, the fix, and Retry; closing it leaves the run on the task page", async () => {
		setAutomationRunsForTest([failedRun()])
		render(<AutomationRunBar taskGroupId="g1" threadId="t1" />)
		const bar = screen.getByTestId("automation-run-bar")
		expect(bar).toHaveTextContent("Failed at step 4")
		expect(bar).toHaveTextContent("isn't a git repository")
		fireEvent.click(within(bar).getByTestId("run-fix-worktrees"))
		expect(mocks.settings).toHaveBeenCalledWith("worktrees")
		fireEvent.click(screen.getByTestId("automation-run-bar-retry"))
		await waitFor(() => expect(mocks.resume).toHaveBeenCalled())
		fireEvent.click(screen.getByRole("button", { name: "Close" }))
		expect(screen.queryByTestId("automation-run-bar")).not.toBeInTheDocument()
	})

	it("points at Ready for review for a while after the run is done", () => {
		const onOpenTaskGroup = vi.fn()
		setAutomationRunsForTest([{ ...waitingRun(), id: "run-done", status: "done", endedAt: Date.now() - 60_000 }])
		render(<AutomationRunBar onOpenTaskGroup={onOpenTaskGroup} taskGroupId="g1" threadId="t2" />)
		expect(screen.getByTestId("automation-run-bar-status")).toHaveTextContent("Ready for review is on the task page")
		fireEvent.click(screen.getByTestId("automation-run-bar-task"))
		expect(onOpenTaskGroup).toHaveBeenCalledWith("g1")
	})

	it("doesn't show long after the run is done", () => {
		setAutomationRunsForTest([{ ...waitingRun(), status: "done" }])
		render(<AutomationRunBar taskGroupId="g1" threadId="t2" />)
		expect(screen.queryByTestId("automation-run-bar")).not.toBeInTheDocument()
	})
})

describe("RunBlock for each and context", () => {
	function fanOutRun(): AutomationRun {
		return {
			id: "run-p",
			automation: "fix-all",
			title: "Fix all",
			values: { tickets: "A-1, A-2, A-3" },
			taskGroupId: "g-parent",
			status: "failed",
			startedAt: 0,
			endedAt: 60_000,
			context: { text: "Only the API.\nNo UI changes.", files: ["/repo/docs/api.md"], images: 1 },
			steps: [
				{
					id: "each",
					kind: "each",
					title: "Each ticket",
					status: "failed",
					threads: [],
					error: "1 of 3 items didn't finish. Retry goes on with only that one.",
					items: [
						{ item: "A-1", label: "A-1", runId: "run-a1", taskGroupId: "g-a1", status: "done" },
						{
							item: "A-2",
							label: "A-2",
							runId: "run-a2",
							taskGroupId: "g-a2",
							status: "failed",
							at: "Fix A-2",
							error: "The model refused.",
						},
						{ item: "A-3", label: "A-3", runId: "run-a3", taskGroupId: "g-a3", status: "done" },
					],
				},
			],
		}
	}

	it("lists every item with its status and task, and says what the user added", () => {
		const onOpenTask = vi.fn()
		render(<RunBlock now={60_000} onOpenTask={onOpenTask} onOpenThread={vi.fn()} run={fanOutRun()} statuses={{}} />)
		expect(screen.getByTestId("run-step-items-each")).toHaveTextContent("2 of 3 done, 1 didn't finish")
		const items = screen.getByTestId("run-items")
		expect(within(items).getByTestId("run-item-A-2")).toHaveTextContent("A-2Failed at Fix A-2")
		expect(within(items).getByTestId("run-item-A-2")).toHaveTextContent("The model refused.")
		fireEvent.click(within(within(items).getByTestId("run-item-A-2")).getByText("Open task"))
		expect(onOpenTask).toHaveBeenCalledWith("g-a2")
		const context = screen.getByTestId("run-context")
		expect(context).toHaveTextContent("Context from you")
		expect(context).toHaveTextContent("Only the API.")
		expect(context).toHaveTextContent("1 image · api.md")
	})

	it("an item's run says which item it is and links back to all of them", () => {
		const parent = fanOutRun()
		const item: AutomationRun = {
			...parent,
			id: "run-a2",
			taskGroupId: "g-a2",
			context: undefined,
			parent: { runId: "run-p", stepId: "each", item: "A-2", index: 1, total: 3 },
			steps: [{ id: "fix", kind: "thread", title: "Fix A-2", status: "failed", threads: [] }],
		}
		setAutomationRunsForTest([parent, item])
		const onOpenTask = vi.fn()
		render(<RunBlock now={60_000} onOpenTask={onOpenTask} onOpenThread={vi.fn()} run={item} statuses={{}} />)
		expect(screen.getByTestId("run-item-of-run-a2")).toHaveTextContent("Item 2 of 3: A-2")
		fireEvent.click(screen.getByText("All items"))
		expect(onOpenTask).toHaveBeenCalledWith("g-parent")
		expect(screen.getByTestId("run-again-run-a2")).toHaveTextContent("Run this item again")
		setAutomationRunsForTest([])
	})
})
