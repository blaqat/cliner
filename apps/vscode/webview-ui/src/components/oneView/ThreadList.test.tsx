import type { HistoryItem } from "@shared/HistoryItem"
import { act, fireEvent, render, screen, within } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ThreadList } from "./ThreadList"

const mocks = vi.hoisted(() => ({
	toggleTaskSettled: vi.fn(),
	toggleTaskStashed: vi.fn(),
	searchHistory: vi.fn(),
	openNote: vi.fn(),
	state: {} as Record<string, unknown>,
}))

vi.mock("@/context/ExtensionStateContext", () => ({ useExtensionState: () => mocks.state }))
vi.mock("@/services/grpc-client", () => ({
	TaskServiceClient: {
		toggleTaskSettled: (request: unknown) => mocks.toggleTaskSettled(request),
		toggleTaskStashed: (request: unknown) => mocks.toggleTaskStashed(request),
	},
	TaskGroupServiceClient: {
		searchHistory: (request: unknown) => mocks.searchHistory(request),
		openNote: (request: unknown) => mocks.openNote(request),
	},
}))

const NOW = Date.UTC(2026, 9, 29, 12)
const item = (id: string, extra: Partial<HistoryItem> = {}): HistoryItem => ({
	id,
	ts: NOW - 60_000,
	task: `task ${id}`,
	tokensIn: 0,
	tokensOut: 0,
	totalCost: 0,
	...extra,
})

const renderList = (props: Partial<Parameters<typeof ThreadList>[0]> = {}) => {
	const handlers = { onOpenThread: vi.fn(), onOpenTaskGroup: vi.fn(), onNewChat: vi.fn() }
	render(<ThreadList now={NOW} {...handlers} {...props} />)
	return handlers
}

const rowFor = (id: string) => screen.getAllByTestId("one-view-row").find((row) => row.dataset.threadId === id) as HTMLElement

describe("ThreadList", () => {
	beforeEach(() => {
		const store = new Map<string, string>()
		vi.stubGlobal("localStorage", {
			getItem: (key: string) => store.get(key) ?? null,
			setItem: (key: string, value: string) => void store.set(key, value),
		})
		mocks.toggleTaskSettled.mockReset().mockResolvedValue({})
		mocks.toggleTaskStashed.mockReset().mockResolvedValue({})
		mocks.searchHistory.mockReset().mockResolvedValue({ results: [] })
		mocks.state = {
			taskHistory: [
				item("wait", {
					title: "Worktree menu rewrite",
					taskGroupId: "g1",
					lastLine: { author: "ask", text: "approve edit to a.ts" },
				}),
				item("run", {
					title: "Home ordering",
					lastLine: { author: "user", text: "order by my message" },
					ts: NOW - 30_000,
				}),
				item("done", {
					title: "Fix CRLF diffs",
					lastLine: { author: "agent", text: "All 81 tests pass." },
					ts: NOW - 120_000,
				}),
				item("you", { title: "Release notes", lastLine: { author: "user", text: "keep it short" }, ts: NOW - 180_000 }),
				item("stashed", { title: "Try Bun 1.5", isStashed: true }),
				item("old", { title: "Old thread", isSettled: true }),
			],
			sessionStatuses: { wait: "waiting", run: "running", stashed: "waiting" },
			taskGroups: [{ id: "g1", title: "Release 3", tags: [], createdAt: NOW, updatedAt: NOW }],
		}
	})

	it("shows each thread's status and last line with who said it", () => {
		renderList({ currentThreadId: "done" })
		expect(within(rowFor("wait")).getByTestId("one-view-row-line")).toHaveTextContent("Needs you: approve edit to a.ts")
		expect(within(rowFor("run")).getByTestId("one-view-row-line")).toHaveTextContent("Working…")
		expect(within(rowFor("done")).getByTestId("one-view-row-line")).toHaveTextContent("Agent: All 81 tests pass.")
		expect(within(rowFor("you")).getByTestId("one-view-row-line")).toHaveTextContent("You: keep it short")
		expect(within(rowFor("run")).getByRole("img", { name: "Running" })).toBeInTheDocument()
		expect(within(rowFor("wait")).getByRole("img", { name: "Waiting for you" })).toBeInTheDocument()
		expect(within(rowFor("done")).getByRole("img", { name: "Done" })).toBeInTheDocument()
		expect(rowFor("done")).toHaveAttribute("aria-current", "true")
		// The task row leads its thread.
		const task = screen.getByTestId("one-view-task")
		expect(within(task).getByTestId("one-view-task-row")).toHaveTextContent("Release 3")
		expect(within(task).getByText("Worktree menu rewrite")).toBeInTheDocument()
	})

	it("keeps Stashed and Settled collapsed, with the stashed thread that needs you counted", () => {
		renderList()
		expect(screen.queryByText("Try Bun 1.5")).toBeNull()
		expect(screen.queryByText("Old thread")).toBeNull()
		expect(screen.getByTestId("one-view-stashed-attention")).toHaveTextContent("1")
		fireEvent.click(screen.getByRole("button", { name: "Expand stashed" }))
		expect(screen.getByText("Try Bun 1.5")).toBeInTheDocument()
		fireEvent.click(screen.getByRole("button", { name: "Expand settled" }))
		expect(screen.getByText("Old thread")).toBeInTheDocument()
	})

	it("opens threads and tasks, and stashes or settles from a row without opening it", () => {
		const handlers = renderList()
		fireEvent.click(rowFor("done"))
		expect(handlers.onOpenThread).toHaveBeenCalledWith("done")
		fireEvent.click(screen.getByTestId("one-view-task-row"))
		expect(handlers.onOpenTaskGroup).toHaveBeenCalledWith("g1")
		handlers.onOpenThread.mockClear()
		fireEvent.click(within(rowFor("done")).getByRole("button", { name: "Stash Fix CRLF diffs" }))
		expect(mocks.toggleTaskStashed).toHaveBeenCalledWith(expect.objectContaining({ taskId: "done" }))
		fireEvent.click(within(rowFor("done")).getByRole("button", { name: "Settle Fix CRLF diffs" }))
		expect(mocks.toggleTaskSettled).toHaveBeenCalledWith(expect.objectContaining({ taskId: "done" }))
		expect(handlers.onOpenThread).not.toHaveBeenCalled()
		fireEvent.click(screen.getByRole("button", { name: "Expand stashed" }))
		expect(within(rowFor("stashed")).getByRole("button", { name: "Unstash Try Bun 1.5" })).toBeInTheDocument()
		fireEvent.click(screen.getByTestId("one-view-new"))
		expect(handlers.onNewChat).toHaveBeenCalled()
	})

	it("moves between rows with ↑/↓ and opens with Enter", () => {
		const handlers = renderList()
		const search = screen.getByTestId("one-view-search")
		search.focus()
		fireEvent.keyDown(search, { key: "ArrowDown" })
		const rows = screen.getAllByRole("button").filter((element) => element.hasAttribute("data-list-row"))
		expect(document.activeElement).toBe(rows[0])
		fireEvent.keyDown(rows[0], { key: "ArrowDown" })
		expect(document.activeElement).toBe(rows[1])
		// Newest first: the running thread, then the task (its thread asked earlier).
		expect(rows[0]).toHaveAttribute("data-thread-id", "run")
		fireEvent.keyDown(rows[1], { key: "Enter" })
		expect(handlers.onOpenTaskGroup).toHaveBeenCalledWith("g1")
		fireEvent.keyDown(rows[0], { key: " " })
		expect(handlers.onOpenThread).toHaveBeenCalledWith("run")
		fireEvent.keyDown(rows[1], { key: "ArrowUp" })
		fireEvent.keyDown(rows[0], { key: "ArrowUp" })
		expect(document.activeElement).toBe(search)
	})

	it("filters in place, shows the message hit, narrows with chips, and Esc clears", async () => {
		vi.useFakeTimers()
		mocks.searchHistory.mockImplementation(async (request: { kind: string }) =>
			request.kind === "messages"
				? {
						results: [
							{
								kind: "message",
								id: "m",
								title: "Release notes",
								threadId: "you",
								snippet: "local drift or CRLF line endings",
								author: "you",
								ts: 1,
							},
						],
					}
				: { results: [{ kind: "note", id: "crlf", title: "CRLF handling", taskGroupId: "g1", snippet: "", ts: 1 }] },
		)
		renderList()
		const search = screen.getByTestId("one-view-search")
		fireEvent.change(search, { target: { value: "crlf" } })
		// Title matches show right away.
		expect(rowFor("done")).toBeInTheDocument()
		expect(screen.queryByText("Home ordering")).toBeNull()
		await act(async () => {
			vi.advanceTimersByTime(250)
		})
		vi.useRealTimers()
		const line = within(rowFor("you")).getByTestId("one-view-row-line")
		expect(line).toHaveTextContent("You: local drift or CRLF line endings")
		expect(within(line).getByTestId("one-view-hit")).toHaveTextContent("CRLF")
		expect(screen.getByTestId("one-view-note-row")).toHaveTextContent("CRLF handling")

		fireEvent.click(screen.getByTestId("one-view-filter"))
		fireEvent.click(screen.getByRole("button", { name: "Notes" }))
		expect(screen.queryByTestId("one-view-row")).toBeNull()
		expect(screen.getByTestId("one-view-note-row")).toBeInTheDocument()

		fireEvent.keyDown(search, { key: "Escape" })
		expect(search).toHaveValue("")
		expect(screen.queryByTestId("one-view-filter-chips")).toBeNull()
		expect(screen.getByText("Home ordering")).toBeInTheDocument()
	})

	it("says when nothing matches and offers to clear", async () => {
		renderList()
		fireEvent.change(screen.getByTestId("one-view-search"), { target: { value: "zzzz" } })
		expect(await screen.findByTestId("one-view-no-matches", undefined, { timeout: 2000 })).toHaveTextContent(
			"No matches for “zzzz”",
		)
		fireEvent.click(screen.getByText("Clear search"))
		expect(screen.getByTestId("one-view-search")).toHaveValue("")
	})

	it("says how to start when there are no threads yet", () => {
		mocks.state = { taskHistory: [], sessionStatuses: {}, taskGroups: [] }
		renderList()
		expect(screen.getByTestId("one-view-empty")).toHaveTextContent("No threads yet — start one in the composer")
	})
})
