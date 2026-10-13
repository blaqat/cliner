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

const openFirstMessage = () => {
	fireEvent.click(screen.getByRole("button", { name: "More actions" }))
	fireEvent.click(screen.getByRole("menuitem", { name: /Show first message/ }))
}

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
		expect(screen.queryByTestId("task-header-first-message")).toBeNull()
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

	it("expands the full first message with openable attachments from the menu", () => {
		mocks.openImage.mockReset().mockResolvedValue({})
		mocks.openFile.mockReset().mockResolvedValue({})
		const longMessage = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n")
		mocks.state = { ...mocks.state, currentTaskItem: item("t1", { task: "Auth refresh" }) }
		render(<TaskHeader onClose={vi.fn()} task={{ ...task, text: longMessage }} />)

		openFirstMessage()

		const panel = screen.getByTestId("task-header-first-message")
		expect(panel).toHaveClass("overflow-y-auto")
		expect(panel).toHaveFocus()
		// Full text, not clamped.
		const full = screen.getByTestId("task-header-full-text")
		expect(full.textContent).toBe(longMessage)
		expect(full.className).not.toMatch(/line-clamp/)

		fireEvent.click(screen.getByAltText("Thumbnail image-1"))
		expect(mocks.openImage).toHaveBeenCalledWith(expect.objectContaining({ value: "data:a" }))
		fireEvent.click(screen.getByText("a.ts"))
		expect(mocks.openFile).toHaveBeenCalledWith(expect.objectContaining({ value: "/a.ts" }))
		// Clicks inside the panel keep it open.
		fireEvent.pointerDown(full)
		expect(screen.getByTestId("task-header-first-message")).toBeInTheDocument()

		fireEvent.click(screen.getByRole("button", { name: "More actions" }))
		fireEvent.click(screen.getByRole("menuitem", { name: /Hide first message/ }))
		expect(screen.queryByTestId("task-header-first-message")).toBeNull()
	})

	it("closes the expanded first message on Escape and on an outside click", () => {
		render(
			<div>
				<TaskHeader onClose={vi.fn()} task={task} />
				<button type="button">outside</button>
			</div>,
		)
		openFirstMessage()
		fireEvent.keyDown(screen.getByTestId("task-header-first-message"), { key: "Escape" })
		expect(screen.queryByTestId("task-header-first-message")).toBeNull()
		expect(screen.getByRole("button", { name: "More actions" })).toHaveFocus()

		openFirstMessage()
		fireEvent.pointerDown(screen.getByRole("button", { name: "outside" }))
		expect(screen.queryByTestId("task-header-first-message")).toBeNull()
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

	it("hides the subagents button without subagents and shows the direct-child count with them", () => {
		const { rerender } = render(<TaskHeader onClose={vi.fn()} task={task} />)
		expect(screen.queryByTestId("subagents-button")).toBeNull()

		const child = item("t1__a", { isSubagent: true, parentTaskId: "t1", task: "explore" })
		mocks.state = { ...mocks.state, taskHistory: [mocks.state.currentTaskItem, child] }
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
		const aside = item("aside", { task: "Aside: Fix migration test", parentTaskId: "root" })
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
})
