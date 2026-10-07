import type { HistoryItem } from "@shared/HistoryItem"
import { fireEvent, render, screen } from "@testing-library/react"
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
})
