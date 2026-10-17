import type { TaskGroupSummary } from "@shared/task-groups"
import { act, fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { getComposerTaskGroup, setComposerPageTaskGroup, setComposerTaskGroup } from "@/components/taskGroup/composerTaskGroup"
import { BranchTaskSuggestion } from "./BranchTaskSuggestion"

const mocks = vi.hoisted(() => ({
	setThreadTaskGroup: vi.fn(),
	updateTaskGroup: vi.fn(),
	state: {} as Record<string, unknown>,
}))

vi.mock("@/context/ExtensionStateContext", () => ({ useExtensionState: () => mocks.state }))
vi.mock("@/services/grpc-client", () => ({
	TaskGroupServiceClient: {
		setThreadTaskGroup: (request: unknown) => mocks.setThreadTaskGroup(request),
		updateTaskGroup: (request: unknown) => mocks.updateTaskGroup(request),
	},
}))

const group = (id: string, title: string, updatedAt: number, branch?: string): TaskGroupSummary => ({
	id,
	title,
	tags: branch ? [{ kind: "branch", value: branch, source: "user" }] : [],
	createdAt: 0,
	updatedAt,
	noteCount: 0,
})

const GROUPS = [group("bulk", "Bulk invoice export", 2, "feat/export"), group("sso", "SSO redirect loop", 1)]

describe("BranchTaskSuggestion", () => {
	beforeEach(() => {
		mocks.setThreadTaskGroup.mockReset().mockResolvedValue({})
		mocks.updateTaskGroup.mockReset().mockResolvedValue({})
		mocks.state = { currentBranch: "feat/export", taskGroups: GROUPS, currentTaskItem: undefined }
		act(() => {
			setComposerTaskGroup(undefined)
			setComposerPageTaskGroup(undefined)
		})
	})

	it("offers to add a new thread to the task, and clicking sets the pending task", () => {
		render(<BranchTaskSuggestion />)
		const chip = screen.getByTestId("branch-task-suggestion")
		expect(chip).toHaveTextContent("Add to⎇Bulk invoice export?")

		fireEvent.click(screen.getByRole("button", { name: /Add to task Bulk invoice export/ }))
		expect(getComposerTaskGroup()).toBe("bulk")
		expect(mocks.setThreadTaskGroup).not.toHaveBeenCalled()
		// Now in that task: nothing left to suggest.
		expect(screen.queryByTestId("branch-task-suggestion")).not.toBeInTheDocument()
	})

	it("says Move to when the new thread already has another task picked", () => {
		act(() => setComposerTaskGroup("sso"))
		render(<BranchTaskSuggestion />)
		expect(screen.getByTestId("branch-task-suggestion")).toHaveTextContent("Move to⎇Bulk invoice export?")
	})

	it("files an existing thread into the task the way the picker does", () => {
		mocks.state.currentTaskItem = { id: "thread-1", taskGroupId: "sso" }
		render(<BranchTaskSuggestion />)
		expect(screen.getByTestId("branch-task-suggestion")).toHaveTextContent("Move to⎇Bulk invoice export?")

		fireEvent.click(screen.getByRole("button", { name: /Move to task Bulk invoice export/ }))
		expect(mocks.setThreadTaskGroup).toHaveBeenCalledWith(
			expect.objectContaining({ threadId: "thread-1", taskGroupId: "bulk" }),
		)
		expect(getComposerTaskGroup()).toBeUndefined()
	})

	it("dismisses the suggestion for that task and persists it", () => {
		render(<BranchTaskSuggestion />)
		fireEvent.click(screen.getByRole("button", { name: "Don't suggest Bulk invoice export again" }))

		expect(mocks.updateTaskGroup).toHaveBeenCalledWith(
			expect.objectContaining({ id: "bulk", branchSuggestionDismissed: true }),
		)
		expect(screen.queryByTestId("branch-task-suggestion")).not.toBeInTheDocument()
		expect(getComposerTaskGroup()).toBeUndefined()
	})

	it("stays hidden once the task is dismissed, and on task pages and subagent threads", () => {
		mocks.state.taskGroups = [{ ...GROUPS[0], branchSuggestionDismissed: true }, GROUPS[1]]
		const { rerender } = render(<BranchTaskSuggestion />)
		expect(screen.queryByTestId("branch-task-suggestion")).not.toBeInTheDocument()

		mocks.state.taskGroups = GROUPS
		act(() => setComposerPageTaskGroup("sso"))
		rerender(<BranchTaskSuggestion />)
		expect(screen.queryByTestId("branch-task-suggestion")).not.toBeInTheDocument()

		act(() => setComposerPageTaskGroup(undefined))
		mocks.state.currentTaskItem = { id: "agent", isSubagent: true }
		rerender(<BranchTaskSuggestion />)
		expect(screen.queryByTestId("branch-task-suggestion")).not.toBeInTheDocument()
	})
})
