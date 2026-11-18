import type { AutomationRun } from "@shared/automations"
import { fireEvent, render, screen } from "@testing-library/react"
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

	it("marks the picked thread", () => {
		expect(finishedThreads(run).map((t) => [t.title, t.picked])).toEqual([
			["Plan A", true],
			["Plan B", false],
			["Build", false],
			["Docs", false],
		])
	})

	it("lists worktrees with changes and every thread that replied", async () => {
		const onOpenThread = vi.fn()
		const onWalkThrough = vi.fn()
		render(<ReadyForReview onOpenThread={onOpenThread} onWalkThrough={onWalkThrough} run={run} />)
		const code = await screen.findByTestId("review-code-build")
		expect(code).toHaveTextContent("6 files changed · 1 commit")
		expect(screen.queryByTestId("review-code-docs")).not.toBeInTheDocument()
		expect(screen.getByTestId("review-thread-a")).toHaveTextContent("you picked it")
		expect(screen.getByTestId("review-thread-b")).toHaveTextContent("Plan B reply")
		fireEvent.click(screen.getByRole("button", { name: "Walk through" }))
		expect(onWalkThrough).toHaveBeenCalledWith("t3")
		fireEvent.click(screen.getAllByRole("button", { name: "Read" })[1])
		expect(onOpenThread).toHaveBeenCalledWith("t2")
		expect(mocks.action).toHaveBeenCalledTimes(2)
	})
})
