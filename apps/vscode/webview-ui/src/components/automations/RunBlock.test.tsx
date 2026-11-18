import type { AutomationRun } from "@shared/automations"
import { fireEvent, render, screen, within } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { setAutomationRunsForTest } from "@/hooks/useAutomationRuns"
import { AutomationRunBar } from "./AutomationRunBar"
import { RunBlock } from "./RunBlock"

const mocks = vi.hoisted(() => ({ stop: vi.fn(), answer: vi.fn(), history: [] as unknown[] }))

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({ taskHistory: mocks.history }),
}))
vi.mock("@/services/grpc-client", () => ({
	AutomationServiceClient: {
		stopAutomationRun: (request: unknown) => mocks.stop(request),
		answerAutomationCheckpoint: (request: unknown) => mocks.answer(request),
		subscribeToAutomationRuns: vi.fn(() => () => {}),
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

describe("RunBlock", () => {
	beforeEach(() => {
		mocks.stop.mockReset().mockResolvedValue({})
		mocks.answer.mockReset().mockResolvedValue({})
		mocks.history = [
			{ id: "t1", totalCost: 0.1 },
			{ id: "t2", totalCost: 0.2 },
		]
	})

	it("shows each step, its threads and replies, time and cost", () => {
		render(<RunBlock now={4 * 60_000} onOpenThread={vi.fn()} run={waitingRun()} statuses={{}} />)
		const block = screen.getByTestId("run-block-run-1")
		expect(block).toHaveTextContent("Ticket to PR")
		expect(block).toHaveTextContent("waiting for you")
		expect(block).toHaveTextContent("3 of 4 · 4 min · $0.30")
		expect(screen.getByTestId("run-thread-r")).toHaveTextContent("Gateway 502s")
		expect(screen.getByTestId("run-step-plan")).toHaveTextContent("2 together")
		// A step that hasn't started doesn't list its threads yet.
		expect(screen.queryByTestId("run-thread-build")).not.toBeInTheDocument()
	})

	it("answers the Ask you step and opens a choice's thread to read it", () => {
		const onOpenThread = vi.fn()
		render(<RunBlock onOpenThread={onOpenThread} run={waitingRun()} statuses={{}} />)
		const checkpoint = screen.getByTestId("run-checkpoint-pick")
		expect(checkpoint).toHaveTextContent("Which plan?")
		fireEvent.click(within(checkpoint).getAllByRole("button", { name: "Read" })[1])
		expect(onOpenThread).toHaveBeenCalledWith("t3")
		fireEvent.click(within(checkpoint).getByRole("button", { name: "Plan A" }))
		expect(mocks.answer).toHaveBeenCalledWith(expect.objectContaining({ runId: "run-1", stepId: "pick", choice: "Plan A" }))
	})

	it("stops a live run, and a thread waiting on approval says it needs you", () => {
		const run = waitingRun()
		run.status = "running"
		run.steps[2].status = "done"
		run.steps[3] = { ...run.steps[3], status: "running", threads: [thread("build", "t4", "running")] }
		render(
			<RunBlock
				onOpenThread={vi.fn()}
				run={run}
				statuses={{ t4: { status: "waiting", liveSubagents: 0, liveSubthreads: 0, attentionSubagents: 0 } }}
			/>,
		)
		expect(screen.getByTestId("run-thread-build")).toHaveTextContent("Needs you")
		fireEvent.click(screen.getByTestId("run-stop-run-1"))
		expect(mocks.stop).toHaveBeenCalledWith(expect.objectContaining({ value: "run-1" }))
	})

	it("folds a finished run to one line", () => {
		const run = { ...waitingRun(), status: "done" as const, endedAt: 60_000 }
		render(<RunBlock defaultOpen={false} onOpenThread={vi.fn()} run={run} statuses={{}} />)
		expect(screen.queryByTestId("run-steps-run-1")).not.toBeInTheDocument()
		fireEvent.click(screen.getByRole("button", { name: /Ticket to PR/ }))
		expect(screen.getByTestId("run-steps-run-1")).toBeInTheDocument()
	})
})

describe("AutomationRunBar", () => {
	it("shows in a run's thread with where it is, unfolds the steps, and stops", () => {
		setAutomationRunsForTest([{ ...waitingRun(), status: "running" }])
		render(<AutomationRunBar onOpenTaskGroup={vi.fn()} threadId="t2" />)
		const bar = screen.getByTestId("automation-run-bar")
		expect(bar).toHaveTextContent("Ticket to PR")
		expect(bar).toHaveTextContent("This thread is step 2")
		fireEvent.click(within(bar).getByRole("button", { name: /Ticket to PR/ }))
		expect(screen.getByTestId("automation-run-bar-steps")).toHaveTextContent("Pick a plan")
		fireEvent.click(screen.getByTestId("automation-run-bar-stop"))
		expect(mocks.stop).toHaveBeenCalled()
	})

	it("shows on the run's task page, and not once the run is over", () => {
		setAutomationRunsForTest([{ ...waitingRun(), status: "running" }])
		const { unmount } = render(<AutomationRunBar taskGroupId="g1" />)
		expect(screen.getByTestId("automation-run-bar")).toBeInTheDocument()
		unmount()
		setAutomationRunsForTest([{ ...waitingRun(), status: "done" }])
		render(<AutomationRunBar taskGroupId="g1" threadId="t2" />)
		expect(screen.queryByTestId("automation-run-bar")).not.toBeInTheDocument()
	})
})
