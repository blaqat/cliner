import type { ClineMessage } from "@shared/ExtensionMessage"
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
const messages: ClineMessage[] = [
	{ ts: 5, type: "say", say: "use_subagents", text: JSON.stringify({ prompts: ["edit files"], access: ["write"] }) },
]

describe("ThreadStrip", () => {
	beforeEach(() => {
		mocks.showTaskWithId.mockReset().mockResolvedValue({})
		mocks.state = { currentTaskItem: root, taskHistory: [root, aside], sessionStatuses: { aside: "running" } }
	})

	it("renders Main, aside and subagent chips with access badges", () => {
		render(<ThreadStrip messages={messages} />)

		const chips = screen.getAllByTestId("thread-chip")
		expect(chips.map((chip) => chip.getAttribute("data-kind"))).toEqual(["main", "aside", "subagent"])
		expect(chips[1]).toHaveTextContent("why?")
		expect(chips[2]).toHaveTextContent("W")
		expect(chips[0]).toHaveAttribute("aria-current", "true")
	})

	it("focuses an aside on click and collapses", () => {
		render(<ThreadStrip messages={messages} />)

		fireEvent.click(screen.getByRole("button", { name: "Aside: why?" }))
		expect(mocks.showTaskWithId).toHaveBeenCalledWith(expect.objectContaining({ value: "aside" }))

		fireEvent.click(screen.getByRole("button", { name: /Threads/ }))
		expect(screen.queryAllByTestId("thread-chip")).toHaveLength(0)
	})

	it("routes subagent chip clicks to onOpenSubagent instead of opening a task", () => {
		const onOpenSubagent = vi.fn()
		render(<ThreadStrip messages={messages} onOpenSubagent={onOpenSubagent} />)

		fireEvent.click(screen.getByRole("button", { name: /Subagent.*edit files/ }))
		expect(onOpenSubagent).toHaveBeenCalledWith(expect.objectContaining({ kind: "subagent", id: "5:1" }))
		expect(mocks.showTaskWithId).not.toHaveBeenCalled()
	})

	it("keeps subagent chips inert without an onOpenSubagent handler", () => {
		render(<ThreadStrip messages={messages} />)
		expect(screen.queryByRole("button", { name: /Subagent.*edit files/ })).toBeNull()
	})

	it("hides a closed chip", () => {
		render(<ThreadStrip messages={messages} />)

		fireEvent.click(screen.getByRole("button", { name: "Close subagent edit files" }))

		expect(screen.getAllByTestId("thread-chip").map((chip) => chip.getAttribute("data-kind"))).toEqual(["main", "aside"])
	})

	it("returns to Main when closing the focused aside", () => {
		mocks.state = { ...mocks.state, currentTaskItem: aside }
		render(<ThreadStrip messages={[]} />)

		fireEvent.click(screen.getByRole("button", { name: "Close aside why?" }))

		expect(mocks.showTaskWithId).toHaveBeenCalledWith(expect.objectContaining({ value: "root" }))
	})

	it("renders nothing for a chat without threads", () => {
		mocks.state = { currentTaskItem: item("solo", 1), taskHistory: [], sessionStatuses: {} }
		const { container } = render(<ThreadStrip messages={[]} />)
		expect(container).toBeEmptyDOMElement()
	})
})
