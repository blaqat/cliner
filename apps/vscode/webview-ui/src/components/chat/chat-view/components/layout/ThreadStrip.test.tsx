import type { HistoryItem } from "@shared/HistoryItem"
import { fireEvent, render, screen, within } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import ThreadStrip from "./ThreadStrip"

const mocks = vi.hoisted(() => ({ showTaskWithId: vi.fn(), state: {} as Record<string, unknown> }))

vi.mock("@/context/ExtensionStateContext", () => ({ useExtensionState: () => mocks.state }))
vi.mock("@/services/grpc-client", () => ({
	TaskServiceClient: { showTaskWithId: (request: unknown) => mocks.showTaskWithId(request) },
}))

const item = (id: string, ts: number, extra: Partial<HistoryItem> = {}): HistoryItem => ({
	id,
	ts,
	task: `task ${id}`,
	tokensIn: 0,
	tokensOut: 0,
	totalCost: 0,
	...extra,
})

const root = item("root", 1)
const aside = item("aside", 2, { parentTaskId: "root", task: "Aside: why?" })
const child = item("root__a", 3, { isSubagent: true, parentTaskId: "root", task: "Subagent report" })

describe("ThreadStrip", () => {
	beforeEach(() => {
		mocks.showTaskWithId.mockReset().mockResolvedValue({})
		mocks.state = { currentTaskItem: root, taskHistory: [root, aside, child], sessionStatuses: { aside: "running" } }
	})

	it("renders Main and asides only, never subagents", () => {
		render(<ThreadStrip />)

		const chips = screen.getAllByTestId("thread-chip")
		expect(chips.map((chip) => chip.getAttribute("data-kind"))).toEqual(["main", "aside"])
		expect(chips[1]).toHaveTextContent("why?")
		expect(chips[0]).toHaveAttribute("aria-current", "true")
		expect(screen.queryByText("Subagent report")).toBeNull()
	})

	it("shows Main as waiting on its subagents and subthreads once its own turn ends", () => {
		mocks.state = { ...mocks.state, sessionStatuses: { root: "done", aside: "running", root__a: "running" } }
		render(<ThreadStrip />)

		const [main, asideChip] = screen.getAllByTestId("thread-chip")
		const icon = within(main).getByRole("img", { name: "Waiting on 1 subagent and 1 subthread" })
		expect(icon).toHaveAttribute("data-status", "subagents")
		expect(within(asideChip).getByRole("img", { name: "Running" })).toBeInTheDocument()
	})

	it("focuses an aside on click and collapses", () => {
		render(<ThreadStrip />)

		fireEvent.click(screen.getByRole("button", { name: "Aside: why?" }))
		expect(mocks.showTaskWithId).toHaveBeenCalledWith(expect.objectContaining({ value: "aside" }))

		fireEvent.click(screen.getByRole("button", { name: /Threads/ }))
		expect(screen.queryAllByTestId("thread-chip")).toHaveLength(0)
	})

	it("returns to Main when closing the focused aside", () => {
		mocks.state = { ...mocks.state, currentTaskItem: aside }
		render(<ThreadStrip />)

		fireEvent.click(screen.getByRole("button", { name: "Close aside why?" }))

		expect(mocks.showTaskWithId).toHaveBeenCalledWith(expect.objectContaining({ value: "root" }))
	})

	it("is hidden for a chat without asides, even when it has subagents", () => {
		mocks.state = { currentTaskItem: root, taskHistory: [root, child], sessionStatuses: {} }
		const { container } = render(<ThreadStrip />)
		expect(container).toBeEmptyDOMElement()
	})

	it("is hidden once every aside chip is closed", () => {
		render(<ThreadStrip />)
		fireEvent.click(screen.getByRole("button", { name: "Close aside why?" }))
		expect(screen.queryByTestId("thread-strip")).toBeNull()
	})

	describe("groups an aside with its own asides", () => {
		const again = item("again", 4, { parentTaskId: "root", task: "Aside: hello again" })
		const deeper = item("deeper", 5, { parentTaskId: "again", task: "Aside: deeper" })
		const deepest = item("deepest", 6, { parentTaskId: "deeper", task: "Aside: deepest" })
		const history = [root, aside, child, again, deeper, deepest]
		const chipTitles = (container: HTMLElement) =>
			within(container)
				.getAllByTestId("thread-chip")
				// The name and the +N count, not status tooltips.
				.map((chip) =>
					[...chip.querySelectorAll(".truncate, [data-testid='thread-group-count']")]
						.map((el) => el.textContent)
						.join(""),
				)

		it("keeps Main as Main from a nested aside and brackets the group in tree order", () => {
			mocks.state = { currentTaskItem: deeper, taskHistory: history, sessionStatuses: {} }
			render(<ThreadStrip />)
			const chips = screen.getAllByTestId("thread-chip")
			expect(chips[0]).toHaveTextContent("Main")
			expect(chips[0]).toHaveAttribute("data-kind", "main")
			const group = screen.getByRole("group", { name: "hello again and its asides" })
			expect(chipTitles(group)).toEqual(["hello again", "deeper", "deepest"])
			// The plain aside isn't in the bracket.
			expect(within(group).queryByText("why?")).toBeNull()
		})

		it("folds to the lead with a count and the most urgent status inside, and unfolds", () => {
			mocks.state = { currentTaskItem: root, taskHistory: history, sessionStatuses: { deepest: "running" } }
			render(<ThreadStrip />)
			fireEvent.click(screen.getByRole("button", { name: "Fold hello again's asides" }))
			const group = screen.getByTestId("thread-group")
			expect(group).toHaveAttribute("data-folded", "true")
			expect(chipTitles(group)).toEqual(["hello again+2"])
			expect(within(group).getByRole("img", { name: "deepest: running" })).toHaveClass("animate-spin")
			fireEvent.click(screen.getByRole("button", { name: "Unfold hello again's asides" }))
			expect(chipTitles(screen.getByTestId("thread-group"))).toEqual(["hello again", "deeper", "deepest"])
		})

		it("never keeps the group you're in folded, and closing the lead hides the group", () => {
			mocks.state = { currentTaskItem: root, taskHistory: history, sessionStatuses: {} }
			const { unmount } = render(<ThreadStrip />)
			fireEvent.click(screen.getByRole("button", { name: "Fold hello again's asides" }))
			unmount()
			mocks.state = { currentTaskItem: deeper, taskHistory: history, sessionStatuses: {} }
			render(<ThreadStrip />)
			const group = screen.getByTestId("thread-group")
			expect(group).not.toHaveAttribute("data-folded")
			fireEvent.click(screen.getByRole("button", { name: "Close aside hello again and its asides" }))
			// You were inside it, so you go back to Main (where buildThreadItems drops the closed group).
			expect(mocks.showTaskWithId).toHaveBeenCalledWith(expect.objectContaining({ value: "root" }))
		})
	})
})
