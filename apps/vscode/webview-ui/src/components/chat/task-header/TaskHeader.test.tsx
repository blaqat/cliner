import type { ClineMessage } from "@shared/ExtensionMessage"
import type { HistoryItem } from "@shared/HistoryItem"
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { shouldCollapseCrumbs } from "./Breadcrumb"
import TaskHeader, { headerTitle } from "./TaskHeader"

const mocks = vi.hoisted(() => ({
	toggleTaskSettled: vi.fn(),
	deleteTasksWithIds: vi.fn(),
	exportTaskWithId: vi.fn(),
	showTaskWithId: vi.fn(),
	renameTask: vi.fn(),
	setThreadTags: vi.fn(),
	resize: undefined as ((width: number) => void) | undefined,
	openImage: vi.fn(),
	openFile: vi.fn(),
	state: {} as Record<string, unknown>,
}))
vi.mock("@/context/ExtensionStateContext", () => ({ useExtensionState: () => mocks.state }))
vi.mock("@/services/grpc-client", () => ({
	TaskServiceClient: {
		toggleTaskSettled: (request: unknown) => mocks.toggleTaskSettled(request),
		deleteTasksWithIds: (request: unknown) => mocks.deleteTasksWithIds(request),
		exportTaskWithId: (request: unknown) => mocks.exportTaskWithId(request),
		showTaskWithId: (request: unknown) => mocks.showTaskWithId(request),
		renameTask: (request: unknown) => mocks.renameTask(request),
		setThreadTags: (request: unknown) => mocks.setThreadTags(request),
		stopSubagent: vi.fn(),
	},
	FileServiceClient: {
		openImage: (request: unknown) => mocks.openImage(request),
		openFile: (request: unknown) => mocks.openFile(request),
	},
}))

const item = (id: string, extra: Partial<HistoryItem> = {}): HistoryItem => ({
	id,
	ts: 1,
	task: "",
	tokensIn: 41_200,
	tokensOut: 6100,
	totalCost: 0.42,
	...extra,
})

const firstMessage = "Refactor the auth middleware so tokens refresh in the background and add tests for the expiry path"
const task: ClineMessage = { ts: 1, type: "say", say: "task", text: firstMessage, images: ["data:a"], files: ["/a.ts", "/b.ts"] }

describe("TaskHeader", () => {
	beforeEach(() => {
		vi.stubGlobal(
			"ResizeObserver",
			class ResizeObserver {
				constructor(callback: ResizeObserverCallback) {
					mocks.resize = (width) =>
						callback([{ contentRect: { width } } as ResizeObserverEntry], this as unknown as ResizeObserver)
				}
				observe() {}
				unobserve() {}
				disconnect() {}
			},
		)
		mocks.toggleTaskSettled.mockReset().mockResolvedValue({})
		mocks.deleteTasksWithIds.mockReset().mockResolvedValue({})
		mocks.showTaskWithId.mockReset().mockResolvedValue({})
		mocks.renameTask.mockReset().mockResolvedValue({})
		mocks.setThreadTags.mockReset().mockResolvedValue({})
		const current = item("t1")
		mocks.state = {
			currentTaskItem: current,
			taskHistory: [current],
			sessionStatuses: {},
			clineMessages: [],
			workspaceRoots: [],
			platform: "darwin",
		}
	})

	it("falls back from the title to the first message", () => {
		expect(headerTitle("Auth refresh", firstMessage)).toBe("Auth refresh")
		expect(headerTitle("  ", "line one\nline two")).toBe("line one line two")
		expect(headerTitle(undefined, undefined)).toBe("New task")
	})

	it("renders one compact row with a truncated title and no context, token or cost display", () => {
		render(<TaskHeader onClose={vi.fn()} task={task} />)

		const title = screen.getByTestId("task-header-title-text")
		expect(title).toHaveTextContent(firstMessage)
		expect(title).toHaveClass("truncate")
		expect(screen.getByTestId("task-header")).not.toHaveTextContent(/\$0\.42|Tokens|Context|Cache/)
	})

	it("prefers the user-set title over the first message", () => {
		mocks.state = { ...mocks.state, currentTaskItem: item("t1", { task: "Auth refresh", title: "Token refresh" }) }
		render(<TaskHeader onClose={vi.fn()} task={task} />)
		expect(screen.getByTestId("task-header-title")).toHaveTextContent("Token refresh")
		mocks.state = { ...mocks.state, currentTaskItem: item("t1", { task: "Auth refresh" }) }
	})

	it("uses the thread's first message when there is no title", () => {
		mocks.state = { ...mocks.state, currentTaskItem: item("t1", { task: "Auth refresh" }) }
		render(<TaskHeader onClose={vi.fn()} task={task} />)
		expect(screen.getByTestId("task-header-title")).toHaveTextContent("Auth refresh")
	})

	it("leaves the first message to the chat: the menu only copies it", () => {
		mocks.state = { ...mocks.state, currentTaskItem: item("t1", { task: "Auth refresh", title: "Token refresh" }) }
		render(<TaskHeader onClose={vi.fn()} task={task} />)

		fireEvent.click(screen.getByRole("button", { name: "More actions" }))
		const items = within(screen.getByRole("menu")).getAllByRole("menuitem")
		expect(items.map((row) => row.textContent)).toEqual(["Walkthrough", "Copy first message"])
		expect(screen.queryByText(firstMessage)).toBeNull()
	})

	it("opens the walkthrough from the thread menu", () => {
		const navigateToWalkthrough = vi.fn()
		mocks.state = { ...mocks.state, navigateToWalkthrough }
		render(<TaskHeader onClose={vi.fn()} task={task} />)
		fireEvent.click(screen.getByRole("button", { name: "More actions" }))
		fireEvent.click(screen.getByRole("menuitem", { name: "Walkthrough" }))
		expect(navigateToWalkthrough).toHaveBeenCalledTimes(1)
	})

	it("settles through toggleTaskSettled and returns home; unsettle stays", async () => {
		const onClose = vi.fn()
		const { rerender } = render(<TaskHeader onClose={onClose} task={task} />)

		fireEvent.click(screen.getByRole("button", { name: "Settle task" }))
		expect(mocks.toggleTaskSettled).toHaveBeenCalledWith(expect.objectContaining({ taskId: "t1" }))
		await waitFor(() => expect(onClose).toHaveBeenCalledOnce())

		mocks.state = { ...mocks.state, currentTaskItem: item("t1", { isSettled: true }) }
		rerender(<TaskHeader onClose={onClose} task={task} />)
		fireEvent.click(screen.getByRole("button", { name: "Unsettle task" }))
		await waitFor(() => expect(mocks.toggleTaskSettled).toHaveBeenCalledTimes(2))
		expect(onClose).toHaveBeenCalledOnce()
	})

	it("deletes through the confirming deleteTasksWithIds RPC", () => {
		render(<TaskHeader onClose={vi.fn()} task={task} />)
		fireEvent.click(screen.getByRole("button", { name: "Delete task" }))
		expect(mocks.deleteTasksWithIds).toHaveBeenCalledWith(expect.objectContaining({ value: ["t1"] }))
	})

	it("closes back home without stopping anything", () => {
		const onClose = vi.fn()
		render(<TaskHeader onClose={onClose} task={task} />)
		fireEvent.click(screen.getByRole("button", { name: "Close" }))
		expect(onClose).toHaveBeenCalledOnce()
		expect(mocks.deleteTasksWithIds).not.toHaveBeenCalled()
	})

	it("hides the subagents button without subagents and badges only running ones", () => {
		const { rerender } = render(<TaskHeader onClose={vi.fn()} task={task} />)
		expect(screen.queryByTestId("subagents-button")).toBeNull()

		const child = item("t1__a", { isSubagent: true, parentTaskId: "t1", task: "explore" })
		mocks.state = { ...mocks.state, taskHistory: [mocks.state.currentTaskItem, child] }
		rerender(<TaskHeader onClose={vi.fn()} task={task} />)
		expect(screen.getByTestId("subagents-button")).toBeInTheDocument()
		expect(screen.queryByTestId("subagents-badge")).toBeNull()

		mocks.state = { ...mocks.state, sessionStatuses: { t1__a: "running" } }
		rerender(<TaskHeader onClose={vi.fn()} task={task} />)
		expect(screen.getByTestId("subagents-badge")).toHaveTextContent("1")
	})

	it("keeps copy and the background-chats shortcut in the overflow menu", async () => {
		const writeText = vi.fn().mockResolvedValue(undefined)
		vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } })
		const onClose = vi.fn()
		mocks.state = { ...mocks.state, sessionStatuses: { other: "running" } }
		render(<TaskHeader onClose={onClose} task={task} />)

		fireEvent.click(screen.getByRole("button", { name: "More actions" }))
		fireEvent.click(screen.getByRole("menuitem", { name: /Copy first message/ }))
		expect(writeText).toHaveBeenCalledWith(firstMessage)

		fireEvent.click(screen.getByRole("menuitem", { name: /1 other chat running/ }))
		expect(onClose).toHaveBeenCalledOnce()
	})

	describe("breadcrumb", () => {
		const root = item("root", { task: "Implement steps 1–2", taskGroupId: "g1" })
		// Asides own their task membership (copied from the parent when forked).
		const aside = item("aside", { task: "Aside: Fix migration test", parentTaskId: "root", taskGroupId: "g1" })
		const nested = () => {
			mocks.state = {
				...mocks.state,
				currentTaskItem: aside,
				taskHistory: [root, aside],
				taskGroups: [{ id: "g1", title: "Bulk invoice export" }],
			}
		}

		it("lists home, the task, ancestor threads and the current subthread", () => {
			nested()
			const onOpenTaskGroup = vi.fn()
			const onClose = vi.fn()
			render(<TaskHeader onClose={onClose} onOpenTaskGroup={onOpenTaskGroup} task={task} />)

			const crumbs = screen.getByTestId("task-breadcrumb")
			expect(crumbs).toHaveTextContent(/Bulk invoice export\/Implement steps 1–2\/↳ Fix migration test/)
			fireEvent.click(screen.getByTestId("crumb-task"))
			expect(onOpenTaskGroup).toHaveBeenCalledWith("g1")
			fireEvent.click(screen.getByText("Implement steps 1–2"))
			expect(mocks.showTaskWithId).toHaveBeenCalledWith(expect.objectContaining({ value: "root" }))
			fireEvent.click(screen.getByTestId("crumb-home"))
			expect(onClose).toHaveBeenCalledOnce()
		})

		it("goes back to the parent level, and home from a top-level thread", () => {
			nested()
			const onClose = vi.fn()
			const { rerender } = render(<TaskHeader onClose={onClose} task={task} />)
			fireEvent.click(screen.getByRole("button", { name: "Back" }))
			expect(mocks.showTaskWithId).toHaveBeenCalledWith(expect.objectContaining({ value: "root" }))

			mocks.state = { ...mocks.state, currentTaskItem: item("t1", { task: "Solo" }), taskHistory: [] }
			rerender(<TaskHeader onClose={onClose} task={task} />)
			expect(screen.queryByTestId("crumb-task")).toBeNull()
			fireEvent.click(screen.getByRole("button", { name: "Back" }))
			expect(onClose).toHaveBeenCalledOnce()
		})

		it("collapses the middle levels below the width threshold", () => {
			expect(shouldCollapseCrumbs(0, 2)).toBe(false)
			expect(shouldCollapseCrumbs(100, 0)).toBe(false)
			expect(shouldCollapseCrumbs(400, 2)).toBe(false)
			expect(shouldCollapseCrumbs(200, 2)).toBe(true)

			nested()
			render(<TaskHeader onClose={vi.fn()} task={task} />)
			act(() => mocks.resize?.(400))
			expect(screen.queryByTestId("crumb-more")).toBeNull()
			act(() => mocks.resize?.(200))
			expect(screen.getByTestId("crumb-more")).toBeInTheDocument()
			expect(screen.queryByTestId("crumb-task")).toBeNull()
			act(() => mocks.resize?.(400))
			expect(screen.queryByTestId("crumb-more")).toBeNull()
		})

		it("lists every level in order from the … menu, current checked", () => {
			nested()
			const onOpenTaskGroup = vi.fn()
			render(<TaskHeader onClose={vi.fn()} onOpenTaskGroup={onOpenTaskGroup} task={task} />)
			act(() => mocks.resize?.(200))
			fireEvent.click(screen.getByTestId("crumb-more"))

			const items = within(screen.getByTestId("crumb-menu")).getAllByRole("menuitem")
			expect(items.map((row) => row.textContent)).toEqual([
				"Home",
				"Bulk invoice export",
				"Implement steps 1–2",
				"↳ Fix migration test",
			])
			expect(items[3]).toHaveAttribute("aria-current", "page")
			expect(items[3]).toBeDisabled()
			fireEvent.click(items[1])
			expect(onOpenTaskGroup).toHaveBeenCalledWith("g1")
		})

		it("renames inline: Enter saves through renameTask", async () => {
			render(<TaskHeader onClose={vi.fn()} task={task} />)
			fireEvent.click(screen.getByRole("button", { name: "Rename thread" }))
			const input = screen.getByTestId("crumb-rename-input")
			expect(input).toHaveFocus()
			expect(input).toHaveValue(firstMessage)
			fireEvent.change(input, { target: { value: "  Auth   refresh " } })
			fireEvent.keyDown(input, { key: "Enter" })

			expect(mocks.renameTask).toHaveBeenCalledOnce()
			expect(mocks.renameTask).toHaveBeenCalledWith(expect.objectContaining({ taskId: "t1", title: "Auth refresh" }))
			expect(screen.queryByTestId("crumb-rename-input")).toBeNull()
			// Shown right away, before history catches up.
			expect(screen.getByTestId("task-header-title-text")).toHaveTextContent("Auth refresh")
		})

		it("renames on double-click and saves with the check button", () => {
			render(<TaskHeader onClose={vi.fn()} task={task} />)
			fireEvent.doubleClick(screen.getByTestId("task-header-title"))
			fireEvent.change(screen.getByTestId("crumb-rename-input"), { target: { value: "Auth refresh" } })
			fireEvent.click(screen.getByRole("button", { name: "Save title" }))
			expect(mocks.renameTask).toHaveBeenCalledWith(expect.objectContaining({ taskId: "t1", title: "Auth refresh" }))
		})

		it("cancels a rename on Escape and skips unchanged titles", () => {
			render(<TaskHeader onClose={vi.fn()} task={task} />)
			fireEvent.click(screen.getByRole("button", { name: "Rename thread" }))
			const input = screen.getByTestId("crumb-rename-input")
			fireEvent.change(input, { target: { value: "Something else" } })
			fireEvent.keyDown(input, { key: "Escape" })
			expect(screen.queryByTestId("crumb-rename-input")).toBeNull()
			expect(screen.getByTestId("task-header-title-text")).toHaveTextContent(firstMessage)

			fireEvent.click(screen.getByRole("button", { name: "Rename thread" }))
			fireEvent.keyDown(screen.getByTestId("crumb-rename-input"), { key: "Enter" })
			expect(mocks.renameTask).not.toHaveBeenCalled()
		})

		it("rolls the title back when the rename fails", async () => {
			mocks.renameTask.mockRejectedValue(new Error("nope"))
			vi.spyOn(console, "error").mockImplementation(() => {})
			render(<TaskHeader onClose={vi.fn()} task={task} />)
			fireEvent.click(screen.getByRole("button", { name: "Rename thread" }))
			fireEvent.change(screen.getByTestId("crumb-rename-input"), { target: { value: "Auth refresh" } })
			fireEvent.keyDown(screen.getByTestId("crumb-rename-input"), { key: "Enter" })
			await waitFor(() => expect(screen.getByTestId("task-header-title-text")).toHaveTextContent(firstMessage))
		})
	})

	describe("thread tags", () => {
		const chipTexts = () =>
			within(screen.getByTestId("thread-tag-row"))
				.queryAllByTestId("task-tag-chip")
				.map((chip) => chip.textContent)
		const withTags = (extra: Partial<HistoryItem>) => {
			const current = item("t1", extra)
			mocks.state = { ...mocks.state, currentTaskItem: current, taskHistory: [current] }
		}

		it("shows the thread's tags under the header", () => {
			withTags({ tags: [{ kind: "ticket", value: "PROJ-482", source: "auto" }] })
			render(<TaskHeader onClose={vi.fn()} task={task} />)
			expect(chipTexts()).toEqual(["PROJ-482×"])
			expect(screen.getByRole("button", { name: "＋ tag" })).toBeInTheDocument()
		})

		it("shows only the quiet ＋ tag affordance without tags", () => {
			render(<TaskHeader onClose={vi.fn()} task={task} />)
			expect(chipTexts()).toEqual([])
			expect(screen.getByTestId("thread-tag-row")).toHaveClass("opacity-60")
			expect(screen.getByRole("button", { name: "＋ tag" })).toBeInTheDocument()
		})

		it("adds a typed tag: ticket keys become tickets, other text labels", async () => {
			render(<TaskHeader onClose={vi.fn()} task={task} />)
			fireEvent.click(screen.getByRole("button", { name: "＋ tag" }))
			fireEvent.change(screen.getByLabelText("New tag"), { target: { value: "PROJ-490" } })
			fireEvent.keyDown(screen.getByLabelText("New tag"), { key: "Enter" })
			expect(chipTexts()).toEqual(["PROJ-490×"])
			expect(mocks.setThreadTags).toHaveBeenLastCalledWith(
				expect.objectContaining({
					taskId: "t1",
					tags: [{ kind: "ticket", value: "PROJ-490", source: "user" }],
					dismissedAutoTags: [],
				}),
			)

			fireEvent.click(screen.getByRole("button", { name: "＋ tag" }))
			fireEvent.change(screen.getByLabelText("New tag"), { target: { value: "backend" } })
			fireEvent.keyDown(screen.getByLabelText("New tag"), { key: "Enter" })
			await waitFor(() =>
				expect(mocks.setThreadTags.mock.lastCall?.[0].tags).toEqual([
					{ kind: "ticket", value: "PROJ-490", source: "user" },
					{ kind: "label", value: "backend", source: "user" },
				]),
			)
		})

		it("removing an auto tag dismisses it; removing a user tag doesn't", () => {
			withTags({
				tags: [
					{ kind: "ticket", value: "PROJ-482", source: "auto" },
					{ kind: "label", value: "invoices", source: "user" },
				],
				dismissedAutoTags: ["PROJ-1"],
			})
			render(<TaskHeader onClose={vi.fn()} task={task} />)
			fireEvent.click(screen.getByRole("button", { name: "Remove tag PROJ-482" }))
			expect(chipTexts()).toEqual(["invoices×"])
			expect(mocks.setThreadTags).toHaveBeenLastCalledWith(
				expect.objectContaining({
					tags: [{ kind: "label", value: "invoices", source: "user" }],
					dismissedAutoTags: ["PROJ-1", "PROJ-482"],
				}),
			)

			fireEvent.click(screen.getByRole("button", { name: "Remove tag invoices" }))
			expect(mocks.setThreadTags.mock.lastCall?.[0].dismissedAutoTags).toEqual(["PROJ-1", "PROJ-482"])
		})

		it("suggests the current branch until it's tagged; one click links it", () => {
			mocks.state.currentBranch = "feat/export"
			render(<TaskHeader onClose={vi.fn()} task={task} />)
			fireEvent.click(screen.getByRole("button", { name: "Add branch tag feat/export" }))
			expect(chipTexts()).toEqual(["feat/export×"])
			expect(screen.queryByRole("button", { name: "Add branch tag feat/export" })).toBeNull()
			expect(mocks.setThreadTags).toHaveBeenLastCalledWith(
				expect.objectContaining({ tags: [{ kind: "branch", value: "feat/export", source: "user" }] }),
			)
		})

		it("doesn't suggest a branch that's already tagged", () => {
			mocks.state.currentBranch = "feat/export"
			withTags({ tags: [{ kind: "branch", value: "feat/export", source: "user" }] })
			render(<TaskHeader onClose={vi.fn()} task={task} />)
			expect(screen.queryByRole("button", { name: "Add branch tag feat/export" })).toBeNull()
		})

		it("rolls the tags back when the save fails", async () => {
			mocks.setThreadTags.mockRejectedValue(new Error("nope"))
			vi.spyOn(console, "error").mockImplementation(() => {})
			withTags({ tags: [{ kind: "label", value: "invoices", source: "user" }] })
			render(<TaskHeader onClose={vi.fn()} task={task} />)
			fireEvent.click(screen.getByRole("button", { name: "Remove tag invoices" }))
			expect(chipTexts()).toEqual([])
			await waitFor(() => expect(chipTexts()).toEqual(["invoices×"]))
		})

		it("has no tag row on read-only subagent threads", () => {
			withTags({ isSubagent: true, parentTaskId: "p" })
			render(<TaskHeader onClose={vi.fn()} task={task} />)
			expect(screen.queryByTestId("thread-tag-row")).toBeNull()
		})
	})
})
