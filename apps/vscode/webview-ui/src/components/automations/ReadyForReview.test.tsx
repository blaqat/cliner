import type { AutomationRun } from "@shared/automations"
import { fireEvent, render, screen, within } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { finishedThreads, ReadyForReview } from "./ReadyForReview"

const mocks = vi.hoisted(() => ({ action: vi.fn() }))
vi.mock("@/components/worktrees/useWorktree", () => ({
	threadWorktreeAction: (...args: unknown[]) => mocks.action(...args),
}))

const thread = (id: string, threadId: string, title: string, extra = {}) => ({
	id,
	threadId,
	title,
	model: "",
	level: "",
	mode: "ask" as const,
	worktree: false,
	status: "done" as const,
	reply: `${title} reply`,
	...extra,
})

const run: AutomationRun = {
	id: "run-1",
	automation: "ticket-to-pr",
	title: "Ticket to PR",
	values: {},
	taskGroupId: "g",
	status: "done",
	startedAt: 0,
	endedAt: 10,
	steps: [
		{
			id: "plan",
			kind: "together",
			title: "Plan",
			status: "done",
			threads: [thread("a", "t1", "Plan A"), thread("b", "t2", "Plan B")],
		},
		{
			id: "pick",
			kind: "checkpoint",
			title: "Pick",
			status: "done",
			threads: [],
			choices: ["Plan A", "Plan B"],
			choice: "Plan A",
		},
		{
			id: "build",
			kind: "thread",
			title: "Build",
			status: "done",
			threads: [thread("build", "t3", "Build", { mode: "act", worktree: true })],
		},
		{
			id: "docs",
			kind: "thread",
			title: "Docs",
			status: "done",
			threads: [thread("docs", "t4", "Docs", { mode: "act", worktree: true })],
		},
	],
}

describe("ReadyForReview", () => {
	beforeEach(() => {
		mocks.action.mockReset().mockImplementation(async (_action: string, id: string) => ({
			summary:
				id === "t3"
					? { changedFiles: 6, commits: 1, uncopiedFiles: 6, copied: false, takenOver: false }
					: { changedFiles: 0, commits: 0, uncopiedFiles: 0, copied: false, takenOver: false },
		}))
	})

	it("lists threads that replied, in step order", () => {
		expect(finishedThreads(run).map((t) => t.title)).toEqual(["Plan A", "Plan B", "Build", "Docs"])
	})

	it("lists only what to look at: worktrees with changes and notes the run wrote", async () => {
		const onWalkThrough = vi.fn()
		const onOpenNote = vi.fn()
		render(
			<ReadyForReview
				noteNames={new Map([["plan", "The plan"]])}
				notesWritten={new Map([["t1", ["plan"]]])}
				onOpenNote={onOpenNote}
				onWalkThrough={onWalkThrough}
				run={run}
			/>,
		)
		const code = await screen.findByTestId("review-code-build")
		expect(code).toHaveTextContent("6 files changed · 1 commit")
		expect(screen.queryByTestId("review-code-docs")).not.toBeInTheDocument()
		// Replies stay with their steps on the run block, not here.
		expect(screen.getByTestId("ready-for-review-run-1")).not.toHaveTextContent("Plan B reply")
		fireEvent.click(screen.getByRole("button", { name: "Walk through" }))
		expect(onWalkThrough).toHaveBeenCalledWith("t3")
		expect(screen.getByTestId("review-note-plan")).toHaveTextContent("The plan")
		fireEvent.click(screen.getByRole("button", { name: "Open note" }))
		expect(onOpenNote).toHaveBeenCalledWith("plan")
		expect(mocks.action).toHaveBeenCalledTimes(2)
	})

	it("sums up a For each run's item tasks that changed files, with links to each", async () => {
		const parent: AutomationRun = {
			...run,
			id: "parent",
			steps: [
				{
					id: "each",
					kind: "each",
					title: "Each item",
					status: "done",
					threads: [],
					items: [
						{ item: "ia", label: "ia", runId: "run-ia", taskGroupId: "task-ia", status: "done" },
						{ item: "ib", label: "ib", runId: "run-ib", taskGroupId: "task-ib", status: "done" },
						{ item: "ic", label: "ic", runId: "run-ic", taskGroupId: "task-ic", status: "done" },
					],
				},
			],
		}
		const itemRun = (id: string, threadId: string): AutomationRun => ({
			...run,
			id,
			steps: [
				{
					id: "write",
					kind: "thread",
					title: "Write",
					status: "done",
					threads: [thread("write", threadId, "Write", { mode: "act", worktree: true })],
				},
			],
		})
		mocks.action.mockImplementation(async (_action: string, id: string) => ({
			summary:
				id === "t-ic"
					? { changedFiles: 0, commits: 0 }
					: { changedFiles: 1, commits: 0, uncopiedFiles: 1, copied: false, takenOver: false, taskGroupId: id },
		}))
		const onOpenTask = vi.fn()
		const onWalkThrough = vi.fn()
		render(
			<ReadyForReview
				itemRuns={[itemRun("run-ia", "t-ia"), itemRun("run-ib", "t-ib"), itemRun("run-ic", "t-ic")]}
				onOpenTask={onOpenTask}
				onWalkThrough={onWalkThrough}
				run={parent}
			/>,
		)
		expect(await screen.findByTestId("review-items-parent")).toHaveTextContent("2 tasks changed files")
		expect(screen.queryByTestId("review-nothing-parent")).not.toBeInTheDocument()
		const ia = screen.getByTestId("review-item-ia")
		expect(ia).toHaveTextContent("1 file changed · not copied here")
		expect(screen.queryByTestId("review-item-ic")).not.toBeInTheDocument()
		fireEvent.click(within(ia).getByRole("button", { name: "Open task" }))
		expect(onOpenTask).toHaveBeenCalledWith("task-ia")
		fireEvent.click(within(screen.getByTestId("review-item-ib")).getByRole("button", { name: "Walk through" }))
		expect(onWalkThrough).toHaveBeenCalledWith("t-ib")
	})

	it("says when there's nothing to review", async () => {
		mocks.action.mockResolvedValue({ summary: { changedFiles: 0, commits: 0 } })
		render(<ReadyForReview onWalkThrough={vi.fn()} run={run} />)
		expect(await screen.findByTestId("review-nothing-run-1")).toHaveTextContent("No code or notes changed")
	})
})
