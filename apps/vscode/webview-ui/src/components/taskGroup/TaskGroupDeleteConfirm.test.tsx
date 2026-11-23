import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { TaskGroupDeleteConfirm } from "./TaskGroupDeleteConfirm"

const mocks = vi.hoisted(() => ({
	deleteTaskGroup: vi.fn(),
	previewTaskGroupDelete: vi.fn(),
	deleteTaskGroupWithThreads: vi.fn(),
}))
vi.mock("@/services/grpc-client", () => ({
	TaskGroupServiceClient: { deleteTaskGroup: (request: unknown) => mocks.deleteTaskGroup(request) },
	TaskGroupDeleteServiceClient: {
		previewTaskGroupDelete: (request: unknown) => mocks.previewTaskGroupDelete(request),
		deleteTaskGroupWithThreads: (request: unknown) => mocks.deleteTaskGroupWithThreads(request),
	},
}))

const thread = (id: string, extra = {}) => ({
	id,
	title: `Thread ${id}`,
	running: false,
	busyElsewhere: false,
	aside: false,
	hasWorktree: false,
	worktreeLosses: 0,
	worktreeNote: "",
	subagents: 0,
	...extra,
})

const onDeleted = vi.fn()
const onCancel = vi.fn()
const renderConfirm = () => render(<TaskGroupDeleteConfirm onCancel={onCancel} onDeleted={onDeleted} taskGroupId="g1" />)
const confirm = () => screen.getByTestId("task-group-delete-confirm")

beforeEach(() => {
	mocks.deleteTaskGroup.mockReset().mockResolvedValue({})
	mocks.previewTaskGroupDelete.mockReset()
	mocks.deleteTaskGroupWithThreads.mockReset().mockResolvedValue({ deleted: true, blocked: "" })
	onDeleted.mockReset()
	onCancel.mockReset()
})

describe("TaskGroupDeleteConfirm", () => {
	it("names what deleting the threads stops and loses, and discards only on that button", async () => {
		mocks.previewTaskGroupDelete.mockResolvedValue({
			threads: [
				thread("a", { running: true, subagents: 2 }),
				thread("b", {
					hasWorktree: true,
					worktreeLosses: 3,
					worktreeNote: "Its worktree has 3 changed files never copied to your workspace. They'll be discarded.",
				}),
				thread("c", { aside: true }),
			],
		})
		renderConfirm()
		const details = await screen.findByTestId("task-group-delete-details")
		expect(details).toHaveTextContent("“Thread a” is running; deleting stops it.")
		expect(details).toHaveTextContent("“Thread b” Its worktree has 3 changed files never copied")
		expect(confirm()).toHaveTextContent("includes 1 side thread and 2 subagent threads")
		expect(confirm()).toHaveTextContent("can’t be restored")

		fireEvent.click(within(confirm()).getByRole("button", { name: "Delete task and 3 threads, discard changes" }))
		expect(mocks.deleteTaskGroupWithThreads).toHaveBeenCalledWith(
			expect.objectContaining({ id: "g1", discardWorktreeWork: true }),
		)
		await waitFor(() => expect(onDeleted).toHaveBeenCalled())
		expect(mocks.deleteTaskGroup).not.toHaveBeenCalled()
	})

	it("keeps the threads with Delete task only", async () => {
		mocks.previewTaskGroupDelete.mockResolvedValue({ threads: [thread("a"), thread("b")] })
		renderConfirm()
		fireEvent.click(await screen.findByRole("button", { name: "Delete task only (keep threads)" }))
		expect(mocks.deleteTaskGroup).toHaveBeenCalledWith(expect.objectContaining({ id: "g1" }))
		expect(mocks.deleteTaskGroupWithThreads).not.toHaveBeenCalled()
		await waitFor(() => expect(onDeleted).toHaveBeenCalled())
	})

	it("can't delete threads running in another window and says where to stop them", async () => {
		mocks.previewTaskGroupDelete.mockResolvedValue({ threads: [thread("a", { busyElsewhere: true, hasWorktree: true })] })
		renderConfirm()
		expect(await screen.findByTestId("task-group-delete-details")).toHaveTextContent(
			"is running in another window. Stop it there first.",
		)
		expect(screen.getByRole("button", { name: "Delete task and its 1 thread" })).toBeDisabled()
		// The task alone can still go.
		expect(screen.getByRole("button", { name: "Delete task only (keep its thread)" })).toBeEnabled()
	})

	it("shows why the host stopped and offers to discard on the next try", async () => {
		mocks.previewTaskGroupDelete.mockResolvedValue({ threads: [thread("a", { hasWorktree: true })] })
		mocks.deleteTaskGroupWithThreads.mockResolvedValueOnce({
			deleted: false,
			blocked: "“Thread a” worktree: Some submodule caches hold work. Nothing was deleted.",
			preview: { threads: [thread("a", { hasWorktree: true })] },
		})
		renderConfirm()
		fireEvent.click(await screen.findByRole("button", { name: "Delete task and its 1 thread" }))
		expect(await screen.findByTestId("task-group-delete-blocked")).toHaveTextContent("Some submodule caches hold work.")
		expect(onDeleted).not.toHaveBeenCalled()
		fireEvent.click(screen.getByRole("button", { name: "Delete task and 1 thread, discard changes" }))
		expect(mocks.deleteTaskGroupWithThreads).toHaveBeenLastCalledWith(expect.objectContaining({ discardWorktreeWork: true }))
	})

	it("offers a plain Delete for a task with no threads", async () => {
		mocks.previewTaskGroupDelete.mockResolvedValue({ threads: [] })
		renderConfirm()
		expect(await within(confirm()).findByText(/It has no threads/)).toBeInTheDocument()
		fireEvent.click(screen.getByRole("button", { name: "Delete" }))
		expect(mocks.deleteTaskGroup).toHaveBeenCalled()
	})
})
