import type { TaskGroupSummary } from "@shared/task-groups"
import { act, fireEvent, render, screen, within } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
	getComposerTaskGroup,
	setComposerPageTaskGroup,
	setComposerTaskGroup,
	setComposerTaskSheetOpen,
} from "@/components/taskGroup/composerTaskGroup"
import WherePill, { ComposerTaskGroupSheet } from "./WherePill"

const mocks = vi.hoisted(() => ({
	setThreadTaskGroup: vi.fn(),
	createTaskGroup: vi.fn(),
	updateTaskGroup: vi.fn(),
	state: {} as Record<string, unknown>,
}))

vi.mock("@/context/ExtensionStateContext", () => ({ useExtensionState: () => mocks.state }))
vi.mock("@/services/grpc-client", () => ({
	TaskGroupServiceClient: {
		setThreadTaskGroup: (request: unknown) => mocks.setThreadTaskGroup(request),
		createTaskGroup: (request: unknown) => mocks.createTaskGroup(request),
		updateTaskGroup: (request: unknown) => mocks.updateTaskGroup(request),
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
	fireEvent.click(screen.getByTestId("where-pill"))
	return screen.getByTestId("where-menu")
}

describe("WherePill: task", () => {
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
			setComposerPageTaskGroup(undefined)
			setComposerTaskSheetOpen(false)
		})
	})

	it("on a task page, the task is fixed: the menu explains it and lists no tasks", () => {
		act(() => setComposerPageTaskGroup("sso"))
		render(<WherePill />)
		const pill = screen.getByTestId("where-pill")
		expect(pill).toHaveTextContent("SSO redirect loop")
		expect(pill).toHaveAttribute("data-fixed", "true")
		const menu = openMenu()
		expect(within(menu).getByTestId("where-fixed-task")).toHaveTextContent("New threads here go into SSO redirect loop.")
		expect(within(menu).queryByLabelText("Find a task")).not.toBeInTheDocument()
		expect(within(menu).queryByText("Bulk invoice export")).not.toBeInTheDocument()
	})

	it("shows No task by default and lists recent tasks newest first with their first tag", () => {
		render(<WherePill />)
		expect(screen.getByTestId("where-pill")).toHaveTextContent("No task")

		const menu = openMenu()
		const titles = within(menu)
			.getAllByRole("menuitemradio")
			.map((button) => button.textContent)
		expect(titles[0]).toContain("Bulk invoice export")
		expect(titles[0]).toContain("PROJ-482")
		expect(titles[1]).toContain("SSO redirect loop")
		expect(within(menu).getByText("No task")).toBeInTheDocument()
		expect(within(menu).getByText("New task…")).toBeInTheDocument()
		expect(within(menu).queryByText("Open task")).not.toBeInTheDocument()
	})

	it("icon-only keeps the label and menu but hides the name and chevron", () => {
		render(<WherePill iconOnly />)
		const pill = screen.getByTestId("where-pill")
		expect(pill).toHaveAttribute("data-icon-only", "true")
		expect(pill).not.toHaveTextContent("No task")
		expect(pill.querySelector(".codicon-tasklist")).not.toBeNull()
		expect(pill.querySelector(".codicon-chevron-down")).toBeNull()
		expect(pill).toHaveAccessibleName()
		expect(within(openMenu()).getByText("No task")).toBeInTheDocument()
	})

	it("in a new thread, picking sets the pending task for the first message", () => {
		render(<WherePill />)
		fireEvent.click(within(openMenu()).getByText("SSO redirect loop"))

		expect(getComposerTaskGroup()).toBe("sso")
		expect(screen.getByTestId("where-pill")).toHaveTextContent("SSO redirect loop")
		expect(mocks.setThreadTaskGroup).not.toHaveBeenCalled()

		fireEvent.click(within(openMenu()).getByText("No task"))
		expect(getComposerTaskGroup()).toBeUndefined()
	})

	it("filters with the find field (title or tag) and Enter picks the first match", () => {
		render(<WherePill />)
		const menu = openMenu()
		fireEvent.change(within(menu).getByLabelText("Find a task"), { target: { value: "477" } })
		expect(within(menu).queryByText("Bulk invoice export")).not.toBeInTheDocument()
		fireEvent.keyDown(within(menu).getByLabelText("Find a task"), { key: "Enter" })
		expect(getComposerTaskGroup()).toBe("sso")
	})

	it("in an existing thread, picking moves the thread and offers Open task", () => {
		mocks.state.currentTaskItem = { id: "thread-1", taskGroupId: "bulk" }
		const onOpenTaskGroup = vi.fn()
		render(<WherePill onOpenTaskGroup={onOpenTaskGroup} />)
		expect(screen.getByTestId("where-pill")).toHaveTextContent("Bulk invoice export")

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
		render(<WherePill />)
		expect(screen.queryByTestId("where-pill")).not.toBeInTheDocument()
	})

	it("New task… opens the sheet prefilled with tickets from the draft, and the new task becomes the pick", async () => {
		render(
			<>
				<WherePill />
				<ComposerTaskGroupSheet draftText="Look into PROJ-491 please" />
			</>,
		)
		fireEvent.click(within(openMenu()).getByText("New task…"))

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

const branchGroup = (id: string, title: string, updatedAt: number, branch?: string): TaskGroupSummary => ({
	id,
	title,
	tags: branch ? [{ kind: "branch", value: branch, source: "user" }] : [],
	createdAt: 0,
	updatedAt,
	noteCount: 0,
})

const BRANCH_GROUPS = [branchGroup("bulk", "Bulk invoice export", 2, "feat/export"), branchGroup("sso", "SSO redirect loop", 1)]

describe("WherePill: branch suggestion", () => {
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
		mocks.updateTaskGroup.mockReset().mockResolvedValue({})
		mocks.state = { currentBranch: "feat/export", taskGroups: BRANCH_GROUPS, currentTaskItem: undefined }
		act(() => {
			setComposerTaskGroup(undefined)
			setComposerPageTaskGroup(undefined)
			setComposerTaskSheetOpen(false)
		})
	})

	it("hints on the pill and offers to add a new thread to the task from inside the menu", () => {
		render(<WherePill />)
		const pill = screen.getByTestId("where-pill")
		expect(pill).toHaveTextContent("No task")
		expect(pill).toHaveAttribute("data-suggestion", "true")
		expect(screen.getByTestId("where-pill-suggestion-hint")).toBeInTheDocument()
		expect(pill).toHaveAccessibleName("No task; suggested: add to Bulk invoice export")
		// Not shown outside the menu.
		expect(screen.queryByTestId("branch-task-suggestion")).not.toBeInTheDocument()

		const menu = openMenu()
		expect(within(menu).getByTestId("branch-task-suggestion")).toHaveTextContent("Add toBulk invoice export?")
		fireEvent.click(within(menu).getByRole("menuitem", { name: /Add to task Bulk invoice export/ }))

		expect(getComposerTaskGroup()).toBe("bulk")
		expect(mocks.setThreadTaskGroup).not.toHaveBeenCalled()
		expect(screen.queryByTestId("where-menu")).not.toBeInTheDocument()
		// Now in that task: nothing left to suggest.
		expect(screen.getByTestId("where-pill")).toHaveTextContent("Bulk invoice export")
		expect(screen.queryByTestId("where-pill-suggestion-hint")).not.toBeInTheDocument()
	})

	it("says Move to when the new thread already has another task picked", () => {
		act(() => setComposerTaskGroup("sso"))
		render(<WherePill />)
		expect(within(openMenu()).getByTestId("branch-task-suggestion")).toHaveTextContent("Move toBulk invoice export?")
	})

	it("files an existing thread into the task the way picking does", () => {
		mocks.state.currentTaskItem = { id: "thread-1", taskGroupId: "sso" }
		render(<WherePill />)
		const menu = openMenu()
		expect(within(menu).getByTestId("branch-task-suggestion")).toHaveTextContent("Move toBulk invoice export?")

		fireEvent.click(within(menu).getByRole("menuitem", { name: /Move to task Bulk invoice export/ }))
		expect(mocks.setThreadTaskGroup).toHaveBeenCalledWith(
			expect.objectContaining({ threadId: "thread-1", taskGroupId: "bulk" }),
		)
		expect(getComposerTaskGroup()).toBeUndefined()
	})

	it("dismisses the suggestion for that task, persists it, and drops the hint", () => {
		render(<WherePill />)
		const menu = openMenu()
		fireEvent.click(within(menu).getByRole("menuitem", { name: "Don't suggest Bulk invoice export again" }))

		expect(mocks.updateTaskGroup).toHaveBeenCalledWith(
			expect.objectContaining({ id: "bulk", branchSuggestionDismissed: true }),
		)
		expect(screen.queryByTestId("branch-task-suggestion")).not.toBeInTheDocument()
		expect(screen.queryByTestId("where-pill-suggestion-hint")).not.toBeInTheDocument()
		expect(getComposerTaskGroup()).toBeUndefined()

		// Still dismissed after the menu closes and reopens, before the server echoes it back.
		fireEvent.keyDown(screen.getByTestId("where-menu"), { key: "Escape" })
		expect(screen.queryByTestId("where-menu")).not.toBeInTheDocument()
		expect(within(openMenu()).queryByTestId("branch-task-suggestion")).not.toBeInTheDocument()
	})

	it("stays hidden once the task is dismissed, and on task pages", () => {
		mocks.state.taskGroups = [{ ...BRANCH_GROUPS[0], branchSuggestionDismissed: true }, BRANCH_GROUPS[1]]
		const { rerender } = render(<WherePill />)
		expect(screen.getByTestId("where-pill")).not.toHaveAttribute("data-suggestion")

		mocks.state.taskGroups = BRANCH_GROUPS
		act(() => setComposerPageTaskGroup("sso"))
		rerender(<WherePill />)
		expect(screen.getByTestId("where-pill")).not.toHaveAttribute("data-suggestion")
		expect(within(openMenu()).queryByTestId("branch-task-suggestion")).not.toBeInTheDocument()
	})

	it("moves from the find field into the list with ArrowDown", () => {
		render(<WherePill />)
		const menu = openMenu()
		const find = within(menu).getByLabelText("Find a task")
		find.focus()
		fireEvent.keyDown(find, { key: "ArrowDown" })
		expect(within(menu).getByRole("menuitem", { name: /Add to task Bulk invoice export/ })).toHaveFocus()
		fireEvent.keyDown(document.activeElement as Element, { key: "ArrowDown" })
		expect(within(menu).getByRole("menuitem", { name: "Don't suggest Bulk invoice export again" })).toHaveFocus()
		fireEvent.keyDown(document.activeElement as Element, { key: "ArrowDown" })
		expect(document.activeElement).toHaveTextContent("Bulk invoice export")
		expect(document.activeElement).toHaveAttribute("role", "menuitemradio")
	})
})
