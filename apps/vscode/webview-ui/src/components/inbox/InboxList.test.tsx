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
		expect(rows[1]).toHaveTextContent("Last active 2m ago")
		expect(screen.getByRole("img", { name: "Running" })).toBeInTheDocument()
		expect(screen.getByRole("img", { name: "Settled" })).toBeInTheDocument()
	})

	it("groups children into icon counts instead of per-subagent status lines", () => {
		mocks.state.taskHistory = [
			item("parent", NOW),
			item("child", NOW + 1, { parentTaskId: "parent", isSubagent: true, task: "Child report" }),
			item("aside", NOW + 2, { parentTaskId: "parent", task: "Aside: q" }),
		]
		mocks.state.sessionStatuses = { parent: "done", child: "done" }
		render(<InboxList now={NOW} showHistoryView={vi.fn()} />)

		const [row] = screen.getAllByTestId("inbox-row")
		expect(screen.getAllByTestId("inbox-row")).toHaveLength(1)
		expect(row).not.toHaveTextContent("Child report")
		expect(screen.queryByRole("button", { name: /Open subagent/ })).toBeNull()
		const subagents = screen.getByTitle("1 subagent")
		expect(subagents).toHaveTextContent("1")
		expect(subagents.querySelector(".codicon-type-hierarchy-sub")).not.toBeNull()
		expect(subagents).toHaveAttribute("data-tone", "idle")
		expect(screen.getByTitle("1 aside").querySelector(".codicon-repo-forked")).not.toBeNull()
	})

	it("turns the subagent count yellow when a child needs the user", () => {
		mocks.state.taskHistory = [
			item("parent", NOW),
			item("a", NOW + 1, { parentTaskId: "parent", isSubagent: true }),
			item("b", NOW + 2, { parentTaskId: "parent", isSubagent: true }),
		]
		mocks.state.sessionStatuses = { parent: "running", a: "waiting", b: "running" }
		render(<InboxList now={NOW} showHistoryView={vi.fn()} />)

		const subagents = screen.getByTitle("2 subagents, 1 needs you, 2 running")
		expect(subagents).toHaveAttribute("data-tone", "attention")
		expect(subagents).toHaveClass("text-warning")
	})

	it("gives every row the same fixed height", () => {
		mocks.state.taskHistory = [
			item("busy", NOW),
			...["a", "b", "c", "d"].map((id, i) =>
				item(id, NOW + i + 1, { parentTaskId: "busy", isSubagent: true, task: `child ${id}` }),
			),
			item("plain", NOW - 1000),
		]
		render(<InboxList now={NOW} showHistoryView={vi.fn()} />)

		const rows = screen.getAllByTestId("inbox-row")
		expect(rows).toHaveLength(2)
		for (const row of rows) {
			expect(row).toHaveClass("h-11")
			expect(row).toHaveClass("overflow-hidden")
		}
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

	describe("settled section", () => {
		const settledHistory = (count: number) =>
			Array.from({ length: count }, (_, i) => item(`s${i}`, NOW - i * 1000, { isSettled: true, settledAt: NOW - i * 1000 }))

		beforeEach(() => {
			const store = new Map<string, string>()
			vi.stubGlobal("localStorage", {
				getItem: (key: string) => store.get(key) ?? null,
				setItem: (key: string, value: string) => void store.set(key, value),
			})
			mocks.state = { taskHistory: settledHistory(40), sessionStatuses: {} }
		})

		it("pages settled chats and shows fewer again", () => {
			render(<InboxList now={NOW} showHistoryView={vi.fn()} />)
			expect(screen.getAllByTestId("inbox-row")).toHaveLength(10)

			fireEvent.click(screen.getByRole("button", { name: /Show more \(30\)/ }))
			expect(screen.getAllByTestId("inbox-row")).toHaveLength(35)

			fireEvent.click(screen.getByRole("button", { name: /Show more \(5\)/ }))
			expect(screen.getAllByTestId("inbox-row")).toHaveLength(40)
			expect(screen.queryByRole("button", { name: /Show more/ })).not.toBeInTheDocument()

			fireEvent.click(screen.getByRole("button", { name: "Show fewer" }))
			expect(screen.getAllByTestId("inbox-row")).toHaveLength(10)
		})

		it("collapses the section, shows the total, and persists the state", async () => {
			const { unmount } = render(<InboxList now={NOW} showHistoryView={vi.fn()} />)
			const toggle = screen.getByRole("button", { name: "Collapse settled chats" })
			expect(toggle).toHaveTextContent("40")

			fireEvent.click(toggle)
			expect(screen.getByRole("button", { name: "Expand settled chats" })).toHaveAttribute("aria-expanded", "false")
			expect(localStorage.getItem("inbox.settledCollapsed")).toBe("1")
			unmount()

			render(<InboxList now={NOW} showHistoryView={vi.fn()} />)
			expect(screen.getByRole("button", { name: "Expand settled chats" })).toBeInTheDocument()
			expect(screen.queryAllByTestId("inbox-row")).toHaveLength(0)
		})
	})

	it("links to the full history", () => {
		const showHistoryView = vi.fn()
		render(<InboxList now={NOW} showHistoryView={showHistoryView} />)
		fireEvent.click(screen.getByRole("button", { name: "View all history" }))
		expect(showHistoryView).toHaveBeenCalled()
	})
})
