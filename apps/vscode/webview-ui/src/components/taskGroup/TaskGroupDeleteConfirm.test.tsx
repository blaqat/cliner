import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { TaskGroupDeleteConfirm } from "./TaskGroupDeleteConfirm"

const mocks = vi.hoisted(() => ({
	deleteTaskGroup: vi.fn(),
	previewTaskGroupDelete: vi.fn(),
	deleteTaskGroupWithThreads: vi.fn(),
	deleteTaskGroupOnly: vi.fn(),
}))
vi.mock("@/services/grpc-client", () => ({
	TaskGroupServiceClient: { deleteTaskGroup: (request: unknown) => mocks.deleteTaskGroup(request) },
	TaskGroupDeleteServiceClient: {
		previewTaskGroupDelete: (request: unknown) => mocks.previewTaskGroupDelete(request),
		deleteTaskGroupWithThreads: (request: unknown) => mocks.deleteTaskGroupWithThreads(request),
		deleteTaskGroupOnly: (request: unknown) => mocks.deleteTaskGroupOnly(request),
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
	usesTaskWorktree: false,
	...extra,
})

const taskWorktree = (extra = {}) => ({
	branch: "cline/task-bulk-export",
	losses: 0,
	note: "",
	refWarning: "",
	runningHere: [] as string[],
	busyElsewhere: false,
	...extra,
})

const onDeleted = vi.fn()
const onCancel = vi.fn()
const onShowTaskWorktree = vi.fn()
const renderConfirm = () =>
	render(
		<TaskGroupDeleteConfirm
			onCancel={onCancel}
			onDeleted={onDeleted}
			onShowTaskWorktree={onShowTaskWorktree}
			taskGroupId="g1"
		/>,
	)
const confirm = () => screen.getByTestId("task-group-delete-confirm")

beforeEach(() => {
	mocks.deleteTaskGroup.mockReset().mockResolvedValue({})
	mocks.previewTaskGroupDelete.mockReset()
	mocks.deleteTaskGroupWithThreads.mockReset().mockResolvedValue({ deleted: true, blocked: "" })
	mocks.deleteTaskGroupOnly.mockReset().mockResolvedValue({ deleted: true, blocked: "" })
	onShowTaskWorktree.mockReset()
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
					worktreeNote:
						"has 3 changed files in its worktree that were never copied to your workspace. They'll be discarded.",
				}),
				thread("c", { aside: true }),
			],
		})
		renderConfirm()
		const details = await screen.findByTestId("task-group-delete-details")
		expect(details).toHaveTextContent("“Thread a” is running; deleting stops it.")
		expect(details).toHaveTextContent("“Thread b” has 3 changed files in its worktree that were never copied")
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
		expect(mocks.deleteTaskGroupOnly).toHaveBeenCalledWith(expect.objectContaining({ id: "g1", discardWorktreeWork: false }))
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
		// Once it's stopped there, Check again enables the delete without reopening the confirm.
		mocks.previewTaskGroupDelete.mockResolvedValue({ threads: [thread("a", { hasWorktree: true })] })
		fireEvent.click(screen.getByRole("button", { name: "Check again" }))
		await waitFor(() => expect(screen.getByRole("button", { name: "Delete task and its 1 thread" })).toBeEnabled())
		expect(screen.queryByRole("button", { name: "Check again" })).toBeNull()
	})

	it("shows why the host stopped and offers to discard on the next try", async () => {
		mocks.previewTaskGroupDelete.mockResolvedValue({ threads: [thread("a", { hasWorktree: true })] })
		mocks.deleteTaskGroupWithThreads.mockResolvedValueOnce({
			deleted: false,
			blocked: "“Thread a” worktree: Some submodule caches hold work. Nothing was deleted.",
			preview: { threads: [thread("a", { hasWorktree: true })], removalConfirmation: "fresh" },
		})
		renderConfirm()
		fireEvent.click(await screen.findByRole("button", { name: "Delete task and its 1 thread" }))
		expect(mocks.deleteTaskGroupWithThreads).toHaveBeenLastCalledWith(
			expect.objectContaining({ discardWorktreeWork: false, removalConfirmation: "" }),
		)
		expect(await screen.findByTestId("task-group-delete-blocked")).toHaveTextContent("Some submodule caches hold work.")
		expect(onDeleted).not.toHaveBeenCalled()
		fireEvent.click(screen.getByRole("button", { name: "Delete task and 1 thread, discard changes" }))
		// The discard is bound to what the host showed last, not to the first look.
		expect(mocks.deleteTaskGroupWithThreads).toHaveBeenLastCalledWith(
			expect.objectContaining({ discardWorktreeWork: true, removalConfirmation: "fresh" }),
		)
	})

	it("offers a plain Delete for a task with no threads", async () => {
		mocks.previewTaskGroupDelete.mockResolvedValue({ threads: [] })
		renderConfirm()
		expect(await within(confirm()).findByText(/It has no threads/)).toBeInTheDocument()
		fireEvent.click(screen.getByRole("button", { name: "Delete" }))
		expect(mocks.deleteTaskGroupOnly).toHaveBeenCalled()
	})

	describe("with a task worktree", () => {
		it("says it's removed first either way, and that kept threads continue in the workspace", async () => {
			mocks.previewTaskGroupDelete.mockResolvedValue({
				threads: [thread("a", { usesTaskWorktree: true }), thread("b", { usesTaskWorktree: true })],
				taskWorktree: taskWorktree(),
			})
			renderConfirm()
			expect(await screen.findByTestId("task-group-delete-worktree")).toHaveTextContent(
				"The task worktree (cline/task-bulk-export) is removed first either way. Kept threads continue in your workspace.",
			)
			fireEvent.click(screen.getByRole("button", { name: "Delete task only (keep threads)" }))
			expect(mocks.deleteTaskGroupOnly).toHaveBeenCalledWith(expect.objectContaining({ discardWorktreeWork: false }))
			await waitFor(() => expect(onDeleted).toHaveBeenCalled())
		})

		it("names uncopied files and Git work only it holds; both choices discard, and Copy them first leads to it", async () => {
			mocks.previewTaskGroupDelete.mockResolvedValue({
				threads: [thread("a", { usesTaskWorktree: true }), thread("b", { usesTaskWorktree: true })],
				taskWorktree: taskWorktree({
					losses: 2,
					note: "The task worktree has 2 changed files that were never copied to your workspace. They’ll be discarded.",
					refWarning:
						"Git work would be lost.\nlib · refs/heads/wip · abc123\nPreserve it or confirm removal to discard it.",
				}),
			})
			renderConfirm()
			const lines = await screen.findByTestId("task-group-delete-worktree")
			expect(lines).toHaveTextContent("has 2 changed files that were never copied")
			expect(lines).toHaveTextContent("lib · refs/heads/wip · abc123")
			expect(screen.getByRole("button", { name: "Delete task only, discard worktree changes" })).toBeEnabled()
			fireEvent.click(screen.getByRole("button", { name: "Copy them first" }))
			expect(onShowTaskWorktree).toHaveBeenCalled()
			fireEvent.click(screen.getByRole("button", { name: "Delete task and 2 threads, discard changes" }))
			expect(mocks.deleteTaskGroupWithThreads).toHaveBeenCalledWith(expect.objectContaining({ discardWorktreeWork: true }))
		})

		it("can only delete the threads with it while one runs in it here, and says how to keep them", async () => {
			mocks.previewTaskGroupDelete.mockResolvedValue({
				threads: [thread("a", { usesTaskWorktree: true, running: true }), thread("b", { usesTaskWorktree: true })],
				taskWorktree: taskWorktree({ runningHere: ["Thread a"] }),
			})
			renderConfirm()
			expect(await screen.findByTestId("task-group-delete-worktree")).toHaveTextContent(
				"“Thread a” is running in it. Deleting the threads stops it; to keep them, stop it first.",
			)
			const only = screen.getByRole("button", { name: "Delete task only (keep threads)" })
			expect(only).toBeDisabled()
			expect(only).toHaveAttribute("title", "Stop the threads running in the task worktree first.")
			expect(screen.getByRole("button", { name: "Delete task and its 2 threads" })).toBeEnabled()
			mocks.previewTaskGroupDelete.mockResolvedValue({
				threads: [thread("a", { usesTaskWorktree: true }), thread("b", { usesTaskWorktree: true })],
				taskWorktree: taskWorktree(),
			})
			fireEvent.click(screen.getByRole("button", { name: "Check again" }))
			await waitFor(() => expect(screen.getByRole("button", { name: "Delete task only (keep threads)" })).toBeEnabled())
		})

		it("blocks both choices while a thread runs in it in another window", async () => {
			mocks.previewTaskGroupDelete.mockResolvedValue({
				threads: [thread("a", { usesTaskWorktree: true })],
				taskWorktree: taskWorktree({ busyElsewhere: true }),
			})
			renderConfirm()
			expect(await screen.findByTestId("task-group-delete-worktree")).toHaveTextContent(
				"A thread using it is running in another window. Stop it there first.",
			)
			expect(screen.getByRole("button", { name: "Delete task and its 1 thread" })).toBeDisabled()
			expect(screen.getByRole("button", { name: "Delete task only (keep its thread)" })).toBeDisabled()
			expect(screen.getByRole("button", { name: "Check again" })).toBeEnabled()
		})

		it("shows the removal's own warning and offers to discard on that choice's next try", async () => {
			mocks.previewTaskGroupDelete.mockResolvedValue({
				threads: [thread("a", { usesTaskWorktree: true })],
				taskWorktree: taskWorktree(),
			})
			mocks.deleteTaskGroupOnly.mockResolvedValueOnce({
				deleted: false,
				blocked:
					"Task worktree: Changes were never copied here. Remove this worktree and discard them? Nothing was deleted.",
				preview: { threads: [thread("a", { usesTaskWorktree: true })], taskWorktree: taskWorktree() },
			})
			renderConfirm()
			fireEvent.click(await screen.findByRole("button", { name: "Delete task only (keep its thread)" }))
			expect(await screen.findByTestId("task-group-delete-blocked")).toHaveTextContent("Changes were never copied here.")
			expect(onDeleted).not.toHaveBeenCalled()
			// Only the choice that warned discards next; the other still asks.
			expect(screen.getByRole("button", { name: "Delete task and its 1 thread" })).toBeInTheDocument()
			fireEvent.click(screen.getByRole("button", { name: "Delete task only, discard worktree changes" }))
			expect(mocks.deleteTaskGroupOnly).toHaveBeenLastCalledWith(expect.objectContaining({ discardWorktreeWork: true }))
		})
	})
})
