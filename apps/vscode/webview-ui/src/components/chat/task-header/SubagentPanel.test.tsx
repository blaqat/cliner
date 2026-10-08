import type { ClineMessage } from "@shared/ExtensionMessage"
import type { HistoryItem } from "@shared/HistoryItem"
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { SubagentPanelButton } from "./SubagentPanel"

const mocks = vi.hoisted(() => ({
	openTask: vi.fn(),
	askResponse: vi.fn(),
	stopSubagent: vi.fn(),
	state: {} as Record<string, unknown>,
}))
vi.mock("@/components/inbox/sessionActions", () => ({ openTask: mocks.openTask, stopSubagent: mocks.stopSubagent }))
vi.mock("@/services/grpc-client", () => ({ TaskServiceClient: { askResponse: mocks.askResponse } }))
vi.mock("@/context/ExtensionStateContext", () => ({ useExtensionState: () => mocks.state }))

const item = (id: string, ts: number, extra: Partial<HistoryItem> = {}): HistoryItem => ({
	id,
	ts,
	task: `task ${id}`,
	tokensIn: 0,
	tokensOut: 0,
	totalCost: 0,
	...extra,
})

const root = item("root", 1, { task: "Refactor auth" })
const a = item("a", 2, { isSubagent: true, parentTaskId: "root", task: "explore-auth" })
const b = item("b", 3, { isSubagent: true, parentTaskId: "root", task: "patch-cookie", subagentAccess: "write" })
const done = item("d", 4, { isSubagent: true, parentTaskId: "root", task: "read-store" })
const nested = item("n", 5, { isSubagent: true, parentTaskId: "a", task: "nested" })
const grandchild = item("g", 6, { isSubagent: true, parentTaskId: "n", task: "grandchild" })
const history = [root, a, b, done, nested, grandchild]

const openPanel = () => fireEvent.click(screen.getByTestId("subagents-button"))
const rows = () => screen.getAllByTestId("lineage-row")

describe("SubagentPanelButton", () => {
	beforeEach(() => {
		vi.stubGlobal(
			"ResizeObserver",
			class ResizeObserver {
				observe() {}
				unobserve() {}
				disconnect() {}
			},
		)
		mocks.openTask.mockReset().mockResolvedValue(undefined)
		mocks.stopSubagent.mockReset().mockResolvedValue(true)
		mocks.state = {
			currentTaskItem: root,
			taskHistory: history,
			sessionStatuses: { a: "running", b: "running", d: "done" },
			clineMessages: [],
		}
	})

	it("is hidden when the lineage has no subagents", () => {
		const solo = item("solo", 1)
		mocks.state = { ...mocks.state, currentTaskItem: solo, taskHistory: [solo] }
		const { container } = render(<SubagentPanelButton />)
		expect(container).toBeEmptyDOMElement()
	})

	it("badges the direct-child count and turns yellow when a child needs the user", () => {
		const { rerender } = render(<SubagentPanelButton />)
		expect(screen.getByTestId("subagents-badge")).toHaveTextContent("3")
		expect(screen.getByTestId("subagents-button")).not.toHaveAttribute("data-attention")
		expect(screen.getByTestId("subagents-badge").className).toContain("bg-badge-background")

		mocks.state = { ...mocks.state, sessionStatuses: { a: "running", b: "waiting" } }
		rerender(<SubagentPanelButton />)
		expect(screen.getByTestId("subagents-button")).toHaveAttribute("data-attention", "true")
		expect(screen.getByTestId("subagents-badge").className).toContain("bg-warning")
	})

	it("opens waiting live children and offers the active approval beside progress totals", async () => {
		mocks.askResponse.mockResolvedValue({})
		const message = { ts: 1, type: "ask", ask: "tool", decisionId: "a-approval" }
		mocks.state = {
			...mocks.state,
			sessionStatuses: { a: "waiting", b: "waiting" },
			taskHistory: [root, { ...a, subagentToolCalls: 2, tokensIn: 100, tokensOut: 20, totalCost: 0.002 }, b],
			pendingSubagentDecisions: [{ taskId: a.id, name: a.task, kind: "approval", message }],
		}
		render(<SubagentPanelButton />)
		openPanel()
		expect(screen.getByTestId("lineage-usage")).toHaveTextContent("2 tools · 120 tokens · $0.0020")
		fireEvent.click(screen.getByRole("button", { name: `Approve ${a.task}` }))
		await waitFor(() =>
			expect(mocks.askResponse).toHaveBeenCalledWith(
				expect.objectContaining({ taskId: root.id, decisionId: "a-approval", responseType: "yesButtonClicked" }),
			),
		)
		fireEvent.click(screen.getByRole("button", { name: `Open ${b.task}` }))
		expect(mocks.openTask).toHaveBeenCalledWith(b.id)
	})

	it("lists the current thread and its direct children only from the root", () => {
		render(<SubagentPanelButton />)
		openPanel()

		expect(rows().map((row) => row.getAttribute("data-relation"))).toEqual(["current", "child", "child", "child"])
		expect(rows()[0]).toHaveTextContent("Refactor auth")
		expect(screen.queryByText("nested")).toBeNull()
		expect(screen.queryByText("grandchild")).toBeNull()
	})

	it("shows the immediate parent, current subagent and its children inside a subagent", () => {
		mocks.state = { ...mocks.state, currentTaskItem: a, sessionStatuses: { n: "waiting" } }
		render(<SubagentPanelButton />)
		openPanel()

		expect(rows().map((row) => row.getAttribute("data-relation"))).toEqual(["parent", "current", "child"])
		expect(rows()[0]).toHaveTextContent("Refactor auth")
		expect(rows()[0]).toHaveTextContent("parent")
		expect(rows()[1]).toHaveTextContent("explore-auth")
		expect(rows()[2]).toHaveTextContent("nested")
		expect(rows()[2]).toHaveTextContent("needs you")
		// No siblings of the current subagent and no grandchildren.
		expect(screen.queryByText("patch-cookie")).toBeNull()
		expect(screen.queryByText("grandchild")).toBeNull()

		fireEvent.click(screen.getByRole("button", { name: "Open parent Refactor auth" }))
		expect(mocks.openTask).toHaveBeenCalledWith("root")
	})

	it("shows access as eye / edit icons with tooltips instead of R/W letters", () => {
		render(<SubagentPanelButton />)
		openPanel()

		const child = rows()[1]
		expect(within(child).getByRole("img", { name: "Read-only" })).toHaveClass("codicon-eye")
		expect(within(rows()[2]).getByRole("img", { name: "Can edit" })).toHaveClass("codicon-edit")
		expect(child).not.toHaveTextContent(/\bR\b/)
	})

	it("opens a child thread on row click and closes the panel", () => {
		render(<SubagentPanelButton />)
		openPanel()

		fireEvent.click(screen.getByRole("button", { name: "Open explore-auth" }))
		expect(mocks.openTask).toHaveBeenCalledWith("a")
		expect(screen.queryByTestId("subagent-panel")).toBeNull()
	})

	it("routes transcript-only children to onOpenPreview", () => {
		const onOpenPreview = vi.fn()
		const messages: ClineMessage[] = [
			{ ts: 9, type: "say", say: "use_subagents", text: JSON.stringify({ prompts: ["legacy"], access: ["read"] }) },
		]
		mocks.state = { ...mocks.state, clineMessages: messages }
		render(<SubagentPanelButton onOpenPreview={onOpenPreview} />)
		openPanel()

		fireEvent.click(screen.getByRole("button", { name: "Open legacy" }))
		expect(onOpenPreview).toHaveBeenCalledWith(expect.objectContaining({ id: "9:1", previewOnly: true }))
		expect(mocks.openTask).not.toHaveBeenCalled()
	})

	it("stops one running child, and Stop all stops every other running child", async () => {
		let finishA: ((ok: boolean) => void) | undefined
		mocks.stopSubagent.mockImplementationOnce(() => new Promise((resolve) => (finishA = resolve)))
		render(<SubagentPanelButton />)
		openPanel()

		expect(screen.queryByRole("button", { name: "Stop read-store" })).toBeNull()
		fireEvent.click(screen.getByRole("button", { name: "Stop explore-auth" }))
		expect(mocks.stopSubagent).toHaveBeenCalledWith("root", "a")
		expect(rows()[1]).toHaveTextContent("stopping…")
		expect(screen.getByRole("button", { name: "Stop explore-auth" })).toBeDisabled()

		// "a" is still in flight, so Stop all only sends "b".
		mocks.stopSubagent.mockClear()
		fireEvent.click(screen.getByRole("button", { name: /Stop all/ }))
		expect(mocks.stopSubagent.mock.calls).toEqual([["root", "b"]])
		await act(async () => finishA?.(true))
	})

	it("clears the pending state once a stopped child leaves running", async () => {
		const { rerender } = render(<SubagentPanelButton />)
		openPanel()
		fireEvent.click(screen.getByRole("button", { name: "Stop explore-auth" }))
		await act(async () => {})
		expect(rows()[1]).toHaveTextContent("stopping…")

		mocks.state = { ...mocks.state, sessionStatuses: { b: "running", d: "done", a: "done" } }
		rerender(<SubagentPanelButton />)
		expect(rows()[1]).toHaveTextContent("done")
		expect(screen.queryByRole("button", { name: "Stop explore-auth" })).toBeNull()

		// If it ever runs again, Stop is available rather than stuck on "stopping…".
		mocks.state = { ...mocks.state, sessionStatuses: { a: "running", b: "running" } }
		rerender(<SubagentPanelButton />)
		expect(rows()[1]).toHaveTextContent("running")
		expect(screen.getByRole("button", { name: "Stop explore-auth" })).toBeEnabled()
	})

	it("shows a retryable error when Stop fails, and retry succeeds", async () => {
		mocks.stopSubagent.mockResolvedValueOnce(false)
		render(<SubagentPanelButton />)
		openPanel()

		fireEvent.click(screen.getByRole("button", { name: "Stop explore-auth" }))
		await waitFor(() => expect(rows()[1]).toHaveTextContent("couldn't stop"))
		expect(screen.getByTestId("subagent-stop-error")).toHaveTextContent("Couldn't stop 1 subagent.")
		const stopA = screen.getByRole("button", { name: "Stop explore-auth" })
		expect(stopA).toBeEnabled()

		fireEvent.click(stopA)
		expect(mocks.stopSubagent).toHaveBeenCalledTimes(2)
		expect(rows()[1]).toHaveTextContent("stopping…")
		expect(screen.queryByTestId("subagent-stop-error")).toBeNull()
	})

	it("keeps Stop all retryable after a partial failure", async () => {
		mocks.stopSubagent.mockImplementation(async (_task: string, id: string) => id !== "b")
		render(<SubagentPanelButton />)
		openPanel()

		fireEvent.click(screen.getByRole("button", { name: /Stop all/ }))
		await waitFor(() => expect(screen.getByTestId("subagent-stop-error")).toHaveTextContent("Couldn't stop 1 subagent."))
		expect(rows()[1]).toHaveTextContent("stopping…")
		expect(rows()[2]).toHaveTextContent("couldn't stop")
		expect(screen.getByRole("button", { name: /Stop all/ })).toBeEnabled()

		mocks.stopSubagent.mockClear()
		mocks.stopSubagent.mockResolvedValue(true)
		fireEvent.click(screen.getByRole("button", { name: "Retry" }))
		expect(mocks.stopSubagent.mock.calls).toEqual([["root", "b"]])
		await waitFor(() => expect(screen.queryByTestId("subagent-stop-error")).toBeNull())
		expect(rows()[2]).toHaveTextContent("stopping…")
	})

	it("resets a stale failed Stop when the panel reopens", async () => {
		mocks.stopSubagent.mockResolvedValueOnce(false)
		render(<SubagentPanelButton />)
		openPanel()
		fireEvent.click(screen.getByRole("button", { name: "Stop explore-auth" }))
		await waitFor(() => expect(screen.getByTestId("subagent-stop-error")).toBeInTheDocument())

		fireEvent.keyDown(document.activeElement as Element, { key: "Escape" })
		expect(screen.queryByTestId("subagent-panel")).toBeNull()
		openPanel()
		expect(screen.queryByTestId("subagent-stop-error")).toBeNull()
		expect(rows()[1]).toHaveTextContent("running")
		expect(screen.getByRole("button", { name: "Stop explore-auth" })).toBeEnabled()
	})

	it("hides Stop all when no child is running", () => {
		mocks.state = { ...mocks.state, sessionStatuses: {} }
		render(<SubagentPanelButton />)
		openPanel()
		expect(screen.queryByRole("button", { name: /Stop all/ })).toBeNull()
	})

	it("moves between rows with the arrow keys and closes on Escape", () => {
		mocks.state = { ...mocks.state, currentTaskItem: a, sessionStatuses: {} }
		render(<SubagentPanelButton />)
		openPanel()

		const parentRow = screen.getByRole("button", { name: "Open parent Refactor auth" })
		expect(parentRow).toHaveFocus()
		fireEvent.keyDown(parentRow, { key: "ArrowDown" })
		expect(screen.getByRole("button", { name: "Open nested" })).toHaveFocus()
		fireEvent.keyDown(document.activeElement as Element, { key: "ArrowDown" })
		expect(parentRow).toHaveFocus()

		fireEvent.keyDown(parentRow, { key: "Escape" })
		expect(screen.queryByTestId("subagent-panel")).toBeNull()
	})
})
