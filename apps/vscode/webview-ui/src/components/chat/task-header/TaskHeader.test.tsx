import type { ClineMessage } from "@shared/ExtensionMessage"
import type { HistoryItem } from "@shared/HistoryItem"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import TaskHeader, { headerTitle } from "./TaskHeader"

const mocks = vi.hoisted(() => ({
	toggleTaskSettled: vi.fn(),
	deleteTasksWithIds: vi.fn(),
	exportTaskWithId: vi.fn(),
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
		showTaskWithId: vi.fn(),
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
				observe() {}
				unobserve() {}
				disconnect() {}
			},
		)
		mocks.toggleTaskSettled.mockReset().mockResolvedValue({})
		mocks.deleteTasksWithIds.mockReset().mockResolvedValue({})
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

	it("uses the thread title when there is one", () => {
		mocks.state = { ...mocks.state, currentTaskItem: item("t1", { task: "Auth refresh" }) }
		render(<TaskHeader onClose={vi.fn()} task={task} />)
		expect(screen.getByTestId("task-header-title")).toHaveTextContent("Auth refresh")
	})

	it("expands the full first message with openable attachments from the title", () => {
		mocks.openImage.mockReset().mockResolvedValue({})
		mocks.openFile.mockReset().mockResolvedValue({})
		const longMessage = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n")
		mocks.state = { ...mocks.state, currentTaskItem: item("t1", { task: "Auth refresh" }) }
		render(<TaskHeader onClose={vi.fn()} task={{ ...task, text: longMessage }} />)

		const title = screen.getByTestId("task-header-title")
		expect(title).toHaveAttribute("aria-expanded", "false")
		fireEvent.click(title)
		expect(title).toHaveAttribute("aria-expanded", "true")

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

		fireEvent.click(title)
		expect(screen.queryByTestId("task-header-first-message")).toBeNull()
	})

	it("closes the expanded first message on Escape and on an outside click", () => {
		render(
			<div>
				<TaskHeader onClose={vi.fn()} task={task} />
				<button type="button">outside</button>
			</div>,
		)
		const title = screen.getByTestId("task-header-title")

		fireEvent.click(title)
		fireEvent.keyDown(screen.getByTestId("task-header-first-message"), { key: "Escape" })
		expect(screen.queryByTestId("task-header-first-message")).toBeNull()
		expect(title).toHaveFocus()

		fireEvent.click(title)
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
})
