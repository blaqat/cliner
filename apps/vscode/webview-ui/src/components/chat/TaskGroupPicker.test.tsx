import type { TaskGroupSummary } from "@shared/task-groups"
import { act, fireEvent, render, screen, within } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { getComposerTaskGroup, setComposerTaskGroup, setComposerTaskSheetOpen } from "@/components/taskGroup/composerTaskGroup"
import TaskGroupPicker, { ComposerTaskGroupSheet } from "./TaskGroupPicker"

const mocks = vi.hoisted(() => ({
	setThreadTaskGroup: vi.fn(),
	createTaskGroup: vi.fn(),
	state: {} as Record<string, unknown>,
}))

vi.mock("@/context/ExtensionStateContext", () => ({ useExtensionState: () => mocks.state }))
vi.mock("@/services/grpc-client", () => ({
	TaskGroupServiceClient: {
		setThreadTaskGroup: (request: unknown) => mocks.setThreadTaskGroup(request),
		createTaskGroup: (request: unknown) => mocks.createTaskGroup(request),
	},
}))

const group = (id: string, title: string, updatedAt: number, tag?: string): TaskGroupSummary => ({
	id,
	title,
	tags: tag ? [{ kind: "ticket", value: tag, source: "user" }] : [],
	createdAt: 0,
	updatedAt,
	noteCount: 0,
})

const GROUPS = [group("sso", "SSO redirect loop", 1, "PROJ-477"), group("bulk", "Bulk invoice export", 2, "PROJ-482")]

function openMenu() {
	fireEvent.click(screen.getByTestId("task-group-picker"))
	return screen.getByTestId("task-group-menu")
}

describe("TaskGroupPicker", () => {
	beforeEach(() => {
		vi.stubGlobal(
			"ResizeObserver",
			class ResizeObserver {
				observe() {}
				unobserve() {}
				disconnect() {}
			},
		)
		mocks.setThreadTaskGroup.mockReset().mockResolvedValue({})
		mocks.createTaskGroup.mockReset().mockResolvedValue({ id: "new" })
		mocks.state = { taskGroups: GROUPS, currentTaskItem: undefined }
		act(() => {
			setComposerTaskGroup(undefined)
			setComposerTaskSheetOpen(false)
		})
	})

	it("shows No task by default and lists recent tasks newest first with their first tag", () => {
		render(<TaskGroupPicker />)
		expect(screen.getByTestId("task-group-picker")).toHaveTextContent("No task")

		const menu = openMenu()
		const titles = within(menu)
			.getAllByRole("button")
			.map((button) => button.textContent)
		expect(titles[0]).toContain("Bulk invoice export")
		expect(titles[0]).toContain("PROJ-482")
		expect(titles[1]).toContain("SSO redirect loop")
		expect(within(menu).getByText("No task")).toBeInTheDocument()
		expect(within(menu).getByText("＋ New task…")).toBeInTheDocument()
		expect(within(menu).queryByText("Open task")).not.toBeInTheDocument()
	})

	it("in a new thread, picking sets the pending task for the first message", () => {
		render(<TaskGroupPicker />)
		fireEvent.click(within(openMenu()).getByText("SSO redirect loop"))

		expect(getComposerTaskGroup()).toBe("sso")
		expect(screen.getByTestId("task-group-picker")).toHaveTextContent("SSO redirect loop")
		expect(mocks.setThreadTaskGroup).not.toHaveBeenCalled()

		fireEvent.click(within(openMenu()).getByText("No task"))
		expect(getComposerTaskGroup()).toBeUndefined()
	})

	it("filters with the find field (title or tag) and Enter picks the first match", () => {
		render(<TaskGroupPicker />)
		const menu = openMenu()
		fireEvent.change(within(menu).getByLabelText("Find a task"), { target: { value: "477" } })
		expect(within(menu).queryByText("Bulk invoice export")).not.toBeInTheDocument()
		fireEvent.keyDown(within(menu).getByLabelText("Find a task"), { key: "Enter" })
		expect(getComposerTaskGroup()).toBe("sso")
	})

	it("in an existing thread, picking moves the thread and offers Open task", () => {
		mocks.state.currentTaskItem = { id: "thread-1", taskGroupId: "bulk" }
		const onOpenTaskGroup = vi.fn()
		render(<TaskGroupPicker onOpenTaskGroup={onOpenTaskGroup} />)
		expect(screen.getByTestId("task-group-picker")).toHaveTextContent("Bulk invoice export")

		fireEvent.click(within(openMenu()).getByText("Open task"))
		expect(onOpenTaskGroup).toHaveBeenCalledWith("bulk")

		fireEvent.click(within(openMenu()).getByText("SSO redirect loop"))
		expect(mocks.setThreadTaskGroup).toHaveBeenCalledWith(
			expect.objectContaining({ threadId: "thread-1", taskGroupId: "sso" }),
		)

		fireEvent.click(within(openMenu()).getByText("No task"))
		expect(mocks.setThreadTaskGroup).toHaveBeenLastCalledWith(
			expect.objectContaining({ threadId: "thread-1", taskGroupId: "" }),
		)
		expect(getComposerTaskGroup()).toBeUndefined()
	})

	it("hides itself on subagent threads", () => {
		mocks.state.currentTaskItem = { id: "agent", isSubagent: true }
		render(<TaskGroupPicker />)
		expect(screen.queryByTestId("task-group-picker")).not.toBeInTheDocument()
	})

	it("New task… opens the sheet prefilled with tickets from the draft, and the new task becomes the pick", async () => {
		render(
			<>
				<TaskGroupPicker />
				<ComposerTaskGroupSheet draftText="Look into PROJ-491 please" />
			</>,
		)
		fireEvent.click(within(openMenu()).getByText("＋ New task…"))

		const sheet = await screen.findByTestId("new-task-sheet")
		expect(within(sheet).getByText("PROJ-491")).toBeInTheDocument()
		expect(sheet).toHaveTextContent("PROJ-491 came from your message. Your message starts the first thread in this task.")

		fireEvent.change(within(sheet).getByLabelText("Title"), { target: { value: "Export timeouts" } })
		await act(async () => {
			fireEvent.click(within(sheet).getByRole("button", { name: "Create task" }))
		})

		expect(mocks.createTaskGroup).toHaveBeenCalledWith(
			expect.objectContaining({
				title: "Export timeouts",
				tags: [{ kind: "ticket", value: "PROJ-491", source: "auto" }],
			}),
		)
		expect(getComposerTaskGroup()).toBe("new")
		expect(screen.queryByTestId("new-task-sheet")).not.toBeInTheDocument()
	})
})
