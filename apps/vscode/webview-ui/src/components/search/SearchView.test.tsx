import type { HistoryItem } from "@shared/HistoryItem"
import type { SearchHistoryResult } from "@shared/proto/cline/task_group"
import { act, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { SEARCH_DEBOUNCE_MS, SearchView } from "./SearchView"

const mocks = vi.hoisted(() => ({
	searchHistory: vi.fn(),
	setThreadTaskGroup: vi.fn(),
	openNote: vi.fn(),
	openTask: vi.fn(),
	navigateToTaskGroup: vi.fn(),
	state: {} as Record<string, unknown>,
}))

vi.mock("@/context/ExtensionStateContext", () => ({ useExtensionState: () => mocks.state }))
vi.mock("@/components/inbox/sessionActions", () => ({ openTask: (id: string) => mocks.openTask(id) }))
vi.mock("@/services/grpc-client", () => ({
	TaskGroupServiceClient: {
		searchHistory: (request: unknown) => mocks.searchHistory(request),
		setThreadTaskGroup: (request: unknown) => mocks.setThreadTaskGroup(request),
		openNote: (request: unknown) => mocks.openNote(request),
	},
}))

const item = (id: string, task: string, extra: Partial<HistoryItem> = {}): HistoryItem => ({
	id,
	ts: 1,
	task,
	tokensIn: 0,
	tokensOut: 0,
	totalCost: 0,
	...extra,
})
const result = (extra: Partial<SearchHistoryResult>): SearchHistoryResult => ({
	kind: "message",
	id: "",
	title: "",
	snippet: "",
	ts: 0,
	taskGroupId: "",
	threadId: "",
	author: "",
	...extra,
})

/** searchHistory answers by kind; `messages` can be swapped per test. */
let serverResults: Record<string, SearchHistoryResult[]> = {}

const flushDebounce = async () => {
	await act(async () => {
		vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS)
	})
}

describe("SearchView", () => {
	beforeEach(() => {
		vi.useFakeTimers()
		vi.stubGlobal(
			"ResizeObserver",
			class {
				observe() {}
				unobserve() {}
				disconnect() {}
			},
		)
		serverResults = {
			notes: [result({ kind: "note", id: "ticket-brief", title: "Ticket brief", taskGroupId: "g1", ts: 5 })],
			messages: [
				result({
					id: "m1",
					title: "Why is CI slow on main?",
					snippet: "queue is blocked by the PROJ-482 export job",
					threadId: "ci",
					ts: 4,
				}),
			],
		}
		mocks.searchHistory
			.mockReset()
			.mockImplementation(async ({ kind }: { kind: string }) => ({ results: serverResults[kind] ?? [] }))
		mocks.setThreadTaskGroup.mockReset().mockResolvedValue({})
		mocks.openNote.mockReset().mockResolvedValue({})
		mocks.openTask.mockReset()
		mocks.navigateToTaskGroup.mockReset()
		mocks.state = {
			navigateToTaskGroup: mocks.navigateToTaskGroup,
			taskGroups: [
				{
					id: "g1",
					title: "Bulk invoice export",
					tags: [{ kind: "ticket", value: "PROJ-482", source: "user" }],
					createdAt: 0,
					updatedAt: 1,
					noteCount: 1,
				},
			],
			taskHistory: [
				item("loose", "Export perf spike", { tags: [{ kind: "ticket", value: "PROJ-482", source: "auto" }] }),
				item("member", "Implement steps 1–2 for PROJ-482", { taskGroupId: "g1" }),
				item("ci", "Why is CI slow on main?"),
			],
		}
	})

	afterEach(() => {
		vi.useRealTimers()
		vi.unstubAllGlobals()
	})

	it("filters messages by who wrote them and labels each one", async () => {
		serverResults.messages = [
			result({
				id: "m-you",
				title: "Why is CI slow on main?",
				snippet: "check PROJ-482",
				threadId: "ci",
				author: "you",
				ts: 6,
			}),
			result({
				id: "m-agent",
				title: "Why is CI slow on main?",
				snippet: "PROJ-482 blocks the queue",
				threadId: "ci",
				author: "agent",
				ts: 4,
			}),
		]
		render(<SearchView initialQuery="PROJ-482" onClose={vi.fn()} />)
		await flushDebounce()
		expect(screen.queryByTestId("search-author-filter")).toBeNull()
		fireEvent.click(screen.getByTestId("search-filter-messages"))
		const snippets = () => screen.getAllByTestId("search-row").map((row) => row.textContent ?? "")
		expect(snippets()).toEqual([
			expect.stringContaining("You: “check PROJ-482”"),
			expect.stringContaining("Agent: “PROJ-482 blocks"),
		])
		fireEvent.click(screen.getByTestId("search-author-you"))
		expect(snippets()).toEqual([expect.stringContaining("You: “check PROJ-482”")])
		fireEvent.click(screen.getByTestId("search-author-agent"))
		expect(snippets()).toEqual([expect.stringContaining("Agent:")])
	})

	it("shows when each result was last active", async () => {
		mocks.state.taskHistory = [item("ci", "Why is CI slow on main?", { lastActivityTs: Date.now() - 2 * 3_600_000 })]
		render(<SearchView initialQuery="CI slow" onClose={vi.fn()} />)
		const time = screen.getAllByTestId("search-row-time")[0]
		expect(time).toHaveTextContent("2h ago")
		expect(time.getAttribute("title")).toMatch(/^Last active /)
	})

	it("carries the query over, autofocuses, and merges local and server results with type labels", async () => {
		render(<SearchView initialQuery="PROJ-482" onClose={vi.fn()} />)
		const input = screen.getByTestId("search-input")
		expect(input).toHaveValue("PROJ-482")
		expect(input).toHaveFocus()

		await flushDebounce()

		expect(mocks.searchHistory).toHaveBeenCalledWith(expect.objectContaining({ query: "PROJ-482", kind: "notes" }))
		expect(mocks.searchHistory).toHaveBeenCalledWith(expect.objectContaining({ query: "PROJ-482", kind: "messages" }))
		const rows = screen.getAllByTestId("search-row")
		expect(rows.map((row) => row.getAttribute("data-kind")).sort()).toEqual(["message", "note", "task", "thread", "thread"])
		expect(screen.getByTestId("search-filter-tasks")).toHaveTextContent("Tasks1")
		expect(screen.getByTestId("search-filter-threads")).toHaveTextContent("Threads2")
		expect(screen.getByTestId("search-filter-notes")).toHaveTextContent("Notes1")
		expect(screen.getByTestId("search-filter-messages")).toHaveTextContent("Messages1")

		const message = rows.find((row) => row.getAttribute("data-kind") === "message")
		expect(message).toHaveTextContent("Message")
		expect(screen.getByTestId("search-hit")).toHaveTextContent("PROJ-482")
	})

	it("filters to one kind while counts stay", async () => {
		render(<SearchView initialQuery="PROJ-482" onClose={vi.fn()} />)
		await flushDebounce()

		fireEvent.click(screen.getByTestId("search-filter-messages"))

		const rows = screen.getAllByTestId("search-row")
		expect(rows).toHaveLength(1)
		expect(rows[0]).toHaveAttribute("data-kind", "message")
		expect(screen.getByTestId("search-filter-threads")).toHaveTextContent("Threads2")
	})

	it("debounces server requests and ignores a stale response", async () => {
		let resolveFirst: (value: { results: SearchHistoryResult[] }) => void = () => {}
		mocks.searchHistory.mockImplementation(({ kind, query }: { kind: string; query: string }) => {
			if (kind !== "messages") return Promise.resolve({ results: [] })
			if (query === "first") {
				return new Promise((resolve) => {
					resolveFirst = resolve
				})
			}
			return Promise.resolve({
				results: [result({ id: "fresh", title: "Fresh thread", snippet: "second hit", threadId: "x" })],
			})
		})
		render(<SearchView initialQuery="first" onClose={vi.fn()} />)
		await flushDebounce()

		const input = screen.getByTestId("search-input")
		fireEvent.change(input, { target: { value: "sec" } })
		fireEvent.change(input, { target: { value: "second" } })
		await flushDebounce()
		// Only the settled query hit the server, not the intermediate keystroke.
		expect(mocks.searchHistory).not.toHaveBeenCalledWith(expect.objectContaining({ query: "sec" }))

		await act(async () => {
			resolveFirst({ results: [result({ id: "stale", title: "Stale thread", snippet: "first", threadId: "y" })] })
		})

		expect(screen.getByText("Fresh thread")).toBeInTheDocument()
		expect(screen.queryByText("Stale thread")).not.toBeInTheDocument()
	})

	it("hides the previous query's server rows as soon as the input changes, keeping the spinner", async () => {
		const { container } = render(<SearchView initialQuery="PROJ-482" onClose={vi.fn()} />)
		await flushDebounce()
		expect(screen.getByText("Ticket brief")).toBeInTheDocument()

		fireEvent.change(screen.getByTestId("search-input"), { target: { value: "PROJ-48" } })

		// Before the debounce fires, the old note/message rows are gone; local matches stay.
		expect(screen.queryByText("Ticket brief")).not.toBeInTheDocument()
		expect(screen.queryByTestId("search-hit")).not.toBeInTheDocument()
		expect(screen.getByText("Bulk invoice export")).toBeInTheDocument()
		expect(container.querySelector(".codicon-loading")).toBeInTheDocument()

		await flushDebounce()
		expect(screen.getByText("Ticket brief")).toBeInTheDocument()
	})

	it("offers Add to task on a loose thread whose tag matches a task", async () => {
		render(<SearchView initialQuery="PROJ-482" onClose={vi.fn()} />)
		await flushDebounce()

		const buttons = screen.getAllByTestId("search-add-to-task")
		expect(buttons).toHaveLength(1)
		await act(async () => {
			fireEvent.click(buttons[0])
		})

		expect(mocks.setThreadTaskGroup).toHaveBeenCalledWith(expect.objectContaining({ threadId: "loose", taskGroupId: "g1" }))
		expect(mocks.openTask).not.toHaveBeenCalled()
		const loose = screen.getAllByTestId("search-row").find((row) => row.textContent?.includes("Export perf spike"))
		expect(loose).toHaveTextContent("Added ✓")
		expect(loose).toHaveTextContent("in Bulk invoice export")
	})

	it("opens tasks, threads, notes and messages", async () => {
		const onClose = vi.fn()
		render(<SearchView initialQuery="PROJ-482" onClose={onClose} />)
		await flushDebounce()
		const byKind = (kind: string) =>
			screen.getAllByTestId("search-row").filter((row) => row.getAttribute("data-kind") === kind)

		fireEvent.click(byKind("task")[0])
		expect(mocks.navigateToTaskGroup).toHaveBeenCalledWith("g1")

		fireEvent.click(byKind("note")[0])
		expect(mocks.openNote).toHaveBeenCalledWith(expect.objectContaining({ taskGroupId: "g1", slug: "ticket-brief" }))

		fireEvent.click(byKind("message")[0])
		expect(mocks.openTask).toHaveBeenCalledWith("ci")

		const member = byKind("thread").find((row) => row.textContent?.includes("Implement steps"))
		fireEvent.click(member as HTMLElement)
		expect(mocks.openTask).toHaveBeenCalledWith("member")
		expect(onClose).toHaveBeenCalled()
	})

	it("returns home on Esc", () => {
		const onClose = vi.fn()
		render(<SearchView initialQuery="" onClose={onClose} />)

		fireEvent.keyDown(screen.getByTestId("search-input"), { key: "Escape" })

		expect(onClose).toHaveBeenCalledTimes(1)
		expect(mocks.searchHistory).not.toHaveBeenCalled()
	})
})
