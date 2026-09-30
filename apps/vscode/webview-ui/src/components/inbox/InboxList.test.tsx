import type { HistoryItem } from "@shared/HistoryItem"
import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import InboxList from "./InboxList"

const mocks = vi.hoisted(() => ({
	showTaskWithId: vi.fn(),
	toggleTaskSettled: vi.fn(),
	state: {} as Record<string, unknown>,
}))

vi.mock("@/context/ExtensionStateContext", () => ({ useExtensionState: () => mocks.state }))
vi.mock("@/services/grpc-client", () => ({
	TaskServiceClient: {
		showTaskWithId: (request: unknown) => mocks.showTaskWithId(request),
		toggleTaskSettled: (request: unknown) => mocks.toggleTaskSettled(request),
	},
}))

const NOW = Date.UTC(2026, 8, 30, 12)
const item = (id: string, ts: number, extra: Partial<HistoryItem> = {}): HistoryItem => ({
	id,
	ts,
	task: `task ${id}`,
	tokensIn: 0,
	tokensOut: 0,
	totalCost: 0,
	...extra,
})

describe("InboxList", () => {
	beforeEach(() => {
		mocks.showTaskWithId.mockReset().mockResolvedValue({})
		mocks.toggleTaskSettled.mockReset().mockResolvedValue({})
		mocks.state = {
			taskHistory: [
				item("run", NOW - 60_000),
				item("aside", NOW - 30_000, { parentTaskId: "run", task: "Aside: q" }),
				item("done", NOW - 120_000, { isSettled: true, settledAt: NOW - 60_000 }),
			],
			sessionStatuses: { run: "running", aside: "running" },
		}
	})

	it("renders Active and Settled groups without top-level asides", () => {
		render(<InboxList now={NOW} showHistoryView={vi.fn()} />)

		const rows = screen.getAllByTestId("inbox-row")
		expect(rows).toHaveLength(2)
		expect(rows[0]).toHaveTextContent("task run")
		expect(rows[0]).toHaveTextContent("Working…")
		expect(rows[0]).toHaveTextContent("1")
		expect(rows[1]).toHaveTextContent("Settled 1m ago")
		expect(screen.getByRole("img", { name: "Running" })).toBeInTheDocument()
		expect(screen.getByRole("img", { name: "Settled" })).toBeInTheDocument()
	})

	it("opens a row and settles without opening", () => {
		render(<InboxList now={NOW} showHistoryView={vi.fn()} />)

		fireEvent.click(screen.getByRole("button", { name: "Settle task run" }))
		expect(mocks.toggleTaskSettled).toHaveBeenCalledWith(expect.objectContaining({ taskId: "run" }))
		expect(mocks.showTaskWithId).not.toHaveBeenCalled()

		fireEvent.click(screen.getByRole("button", { name: "Unsettle task done" }))
		expect(mocks.toggleTaskSettled).toHaveBeenLastCalledWith(expect.objectContaining({ taskId: "done" }))

		fireEvent.click(screen.getAllByTestId("inbox-row")[0])
		expect(mocks.showTaskWithId).toHaveBeenCalledWith(expect.objectContaining({ value: "run" }))
	})

	it("links to the full history", () => {
		const showHistoryView = vi.fn()
		render(<InboxList now={NOW} showHistoryView={showHistoryView} />)
		fireEvent.click(screen.getByRole("button", { name: "View all history" }))
		expect(showHistoryView).toHaveBeenCalled()
	})
})
