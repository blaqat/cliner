import type { HistoryItem } from "@shared/HistoryItem"
import { fireEvent, render, screen, within } from "@testing-library/react"
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

	it("ages a row by its newest subthread, not the parent's own ts", () => {
		mocks.state.taskHistory = [
			item("parent", NOW - 3 * 60 * 60_000),
			item("aside", NOW - 5 * 60_000, { parentTaskId: "parent" }),
		]
		mocks.state.sessionStatuses = {}
		render(<InboxList now={NOW} showHistoryView={vi.fn()} />)

		const [row] = screen.getAllByTestId("inbox-row")
		expect(row).toHaveTextContent("5m")
		expect(row).not.toHaveTextContent("3h")
	})

	it("shows subthread work on an idle parent", () => {
		mocks.state.sessionStatuses = { run: "done", aside: "running" }
		render(<InboxList now={NOW} showHistoryView={vi.fn()} />)

		expect(screen.getAllByTestId("inbox-row")[0]).toHaveTextContent("Working… in subthread")
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

describe("InboxList task groups", () => {
	beforeEach(() => {
		const store = new Map<string, string>()
		vi.stubGlobal("localStorage", {
			getItem: (key: string) => store.get(key) ?? null,
			setItem: (key: string, value: string) => void store.set(key, value),
		})
		mocks.showTaskWithId.mockReset().mockResolvedValue({})
		mocks.state = {
			taskHistory: [
				item("m1", NOW - 2 * 60_000, { taskGroupId: "g", task: "Implement steps" }),
				item("m2", NOW - 60 * 60_000, { taskGroupId: "g", task: "Dev plan" }),
				item("m3", NOW - 120 * 60_000, { taskGroupId: "g", task: "Refine ticket" }),
				item("m4", NOW - 180 * 60_000, { taskGroupId: "g", task: "Research" }),
				item("loose", NOW - 30 * 60_000, { task: "Loose thread" }),
			],
			sessionStatuses: { m1: "running" },
			taskGroups: [
				{
					id: "g",
					title: "Bulk invoice export",
					tags: [{ kind: "ticket", value: "PROJ-482", source: "user" }],
					createdAt: 0,
					updatedAt: 0,
					noteCount: 0,
				},
			],
		}
	})

	it("shows a collapsed group row with tags, thread count, age and running count", () => {
		render(<InboxList now={NOW} showHistoryView={vi.fn()} />)

		const row = screen.getByTestId("inbox-task-group-row")
		expect(row).toHaveTextContent("Bulk invoice export")
		expect(row).toHaveTextContent("PROJ-482")
		expect(row).toHaveTextContent("4 threads")
		expect(row).toHaveTextContent("2m")
		expect(screen.getByTestId("inbox-task-group-running")).toHaveTextContent("1 running")
		// Members stay out of the top level; only the loose thread is a row.
		expect(screen.getAllByTestId("inbox-row").map((el) => el.textContent)).toEqual([expect.stringContaining("Loose thread")])
	})

	it("expands to the two newest members plus an older count, and remembers it", () => {
		const { unmount } = render(<InboxList now={NOW} showHistoryView={vi.fn()} />)
		fireEvent.click(screen.getByRole("button", { name: "Expand Bulk invoice export" }))

		const members = screen.getByTestId("inbox-task-group-members")
		expect(members).toHaveTextContent("Implement steps")
		expect(members).toHaveTextContent("Dev plan")
		expect(members).not.toHaveTextContent("Refine ticket")
		expect(members).toHaveTextContent("＋2 older")
		unmount()

		render(<InboxList now={NOW} showHistoryView={vi.fn()} />)
		expect(screen.getByRole("button", { name: "Collapse Bulk invoice export" })).toHaveAttribute("aria-expanded", "true")
		fireEvent.click(screen.getByRole("button", { name: "Collapse Bulk invoice export" }))
		expect(screen.queryByTestId("inbox-task-group-members")).not.toBeInTheDocument()
	})

	it("opens the task from the row and from Open task ›, and opens member threads", () => {
		const onOpenTaskGroup = vi.fn()
		render(<InboxList now={NOW} onOpenTaskGroup={onOpenTaskGroup} showHistoryView={vi.fn()} />)

		fireEvent.click(screen.getByTestId("inbox-task-group-row"))
		expect(onOpenTaskGroup).toHaveBeenCalledWith("g")

		fireEvent.click(screen.getByRole("button", { name: "Expand Bulk invoice export" }))
		expect(onOpenTaskGroup).toHaveBeenCalledTimes(1)
		fireEvent.click(screen.getByRole("button", { name: "Open task ›" }))
		expect(onOpenTaskGroup).toHaveBeenCalledTimes(2)

		fireEvent.click(screen.getByText("Implement steps"))
		expect(mocks.showTaskWithId).toHaveBeenCalled()
	})

	it("lists an empty group under Settled, with No threads yet when expanded", () => {
		mocks.state.taskHistory = []
		localStorage.setItem("inbox.expandedTaskGroups", JSON.stringify(["g"]))
		render(<InboxList now={NOW} showHistoryView={vi.fn()} />)

		const row = screen.getByTestId("inbox-task-group-row")
		expect(row).toHaveTextContent("0 threads")
		expect(row).toHaveAttribute("data-settled", "true")
		expect(isAfter(row, screen.getByRole("button", { name: "Collapse settled chats" }))).toBe(true)
		expect(screen.getByTestId("inbox-task-group-members")).toHaveTextContent("No threads yet")
	})

	it("moves a group whose threads are all settled to Settled, where it still expands and opens", () => {
		mocks.state.taskHistory = [
			item("m1", NOW - 2 * 60_000, { taskGroupId: "g", task: "Implement steps", isSettled: true }),
			item("m2", NOW - 60 * 60_000, { taskGroupId: "g", task: "Dev plan", isSettled: true }),
			item("loose", NOW - 30 * 60_000, { task: "Loose thread" }),
			item("old", NOW - 90 * 60_000, { task: "Old settled", isSettled: true }),
		]
		mocks.state.sessionStatuses = {}
		const onOpenTaskGroup = vi.fn()
		render(<InboxList now={NOW} onOpenTaskGroup={onOpenTaskGroup} showHistoryView={vi.fn()} />)

		const settledHeader = screen.getByRole("button", { name: "Collapse settled chats" })
		expect(settledHeader).toHaveTextContent("Settled2")
		const row = screen.getByTestId("inbox-task-group-row")
		expect(isAfter(row, settledHeader)).toBe(true)
		// Newest activity first: the task (2m) above the older settled thread.
		expect(isAfter(screen.getByText("Old settled"), row)).toBe(true)
		expect(screen.queryByTestId("inbox-task-group-running")).not.toBeInTheDocument()

		fireEvent.click(screen.getByRole("button", { name: "Expand Bulk invoice export" }))
		expect(screen.getByTestId("inbox-task-group-members")).toHaveTextContent("Implement steps")
		fireEvent.click(screen.getByRole("button", { name: "Open task ›" }))
		expect(onOpenTaskGroup).toHaveBeenCalledWith("g")
	})
})

/** `node` comes after `other` in document order. */
function isAfter(node: Element, other: Element): boolean {
	return !!(other.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)
}

describe("InboxList thread tags", () => {
	beforeEach(() => {
		mocks.state = {
			taskHistory: [
				item("tagged", NOW - 60_000, {
					task: "Tagged thread",
					tags: [
						{ kind: "ticket", value: "PROJ-482", source: "auto" },
						{ kind: "branch", value: "feat/export", source: "user" },
						{ kind: "label", value: "invoices", source: "user" },
						{ kind: "label", value: "backend", source: "user" },
					],
				}),
				item("plain", NOW - 120_000, { task: "Plain thread" }),
				item("member", NOW - 30_000, {
					taskGroupId: "tg",
					task: "Member thread",
					tags: [{ kind: "label", value: "spike", source: "user" }],
				}),
			],
			sessionStatuses: {},
			taskGroups: [
				{
					id: "tg",
					title: "Group",
					tags: [{ kind: "ticket", value: "PROJ-9", source: "user" }],
					createdAt: 0,
					updatedAt: 0,
					noteCount: 0,
				},
			],
		}
	})

	it("shows up to two tag chips plus +N on a thread row, and none on an untagged row", () => {
		render(<InboxList now={NOW} showHistoryView={vi.fn()} />)

		const [tagged, plain] = screen.getAllByTestId("inbox-row")
		const chips = within(tagged).getAllByTestId("task-tag-chip")
		expect(chips.map((chip) => chip.textContent)).toEqual(["PROJ-482", "feat/export"])
		const overflow = within(tagged).getByTestId("row-tag-overflow")
		expect(overflow).toHaveTextContent("+2")
		expect(overflow).toHaveAttribute("title", "invoices, backend")
		// Tags share the activity line, so the row keeps its fixed height.
		expect(within(tagged).getByTestId("inbox-row-detail")).toHaveTextContent("Done")
		expect(tagged).toHaveClass("h-11")
		expect(within(plain).queryByTestId("task-tag-chip")).toBeNull()
	})

	it("lists only a member's own tags under its task row, which already shows the task's", () => {
		render(<InboxList now={NOW} showHistoryView={vi.fn()} />)
		fireEvent.click(screen.getByRole("button", { name: "Expand Group" }))

		const members = screen.getByTestId("inbox-task-group-members")
		expect(within(members).getByTestId("task-tag-chip")).toHaveTextContent("spike")
		expect(within(screen.getByTestId("inbox-task-group-row")).getByTestId("task-tag-chip")).toHaveTextContent("PROJ-9")
	})
})
