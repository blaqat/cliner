import type { HistoryItem } from "@shared/HistoryItem"
import { fireEvent, render, screen, within } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { buildInbox } from "@/components/inbox/inboxUtils"
import { ThreadStripBar } from "./ThreadStripBar"
import { stripEntries } from "./threadListModel"

const item = (id: string, taskGroupId?: string): HistoryItem => ({
	id,
	task: id,
	ts: 1000,
	tokensIn: 0,
	tokensOut: 0,
	totalCost: 0,
	taskGroupId,
})
let width = 800
beforeEach(() => {
	width = 800
	vi.stubGlobal(
		"ResizeObserver",
		class {
			constructor(private callback: ResizeObserverCallback) {}
			observe() {
				this.callback([{ contentRect: { width } } as ResizeObserverEntry], this as unknown as ResizeObserver)
			}
			disconnect() {}
		},
	)
})
const setup = (currentRowId = "a") => {
	const history = [item("a", "g"), item("b", "g"), item("loose")]
	const inbox = buildInbox(history, { a: "running", b: "waiting" }, undefined, {
		taskGroups: [{ id: "g", title: "Release", tags: [], createdAt: 1000, updatedAt: 1000 }],
	})
	const handlers = { onOpenThread: vi.fn(), onToggleList: vi.fn(), onSearch: vi.fn() }
	render(
		<ThreadStripBar
			currentRowId={currentRowId}
			entries={stripEntries(inbox, currentRowId, history)}
			listOpen={false}
			{...handlers}
		/>,
	)
	return handlers
}
describe("ThreadStripBar", () => {
	it("groups task tabs, retains statuses and selects the open thread", () => {
		const handlers = setup()
		const group = screen.getByRole("group", { name: "Release" })
		expect(within(group).getByRole("img", { name: "Running" })).toBeInTheDocument()
		expect(within(group).getByRole("img", { name: "Waiting for you" })).toBeInTheDocument()
		expect(within(group).getByTitle("a")).toHaveAttribute("aria-current", "true")
		fireEvent.click(screen.getByTitle("loose"))
		expect(handlers.onOpenThread).toHaveBeenCalledWith("loose")
		expect(screen.queryByTestId("one-view-strip-new")).toBeNull()
	})
	it("keeps the selected task tab visible when overflow hides other threads", () => {
		width = 220
		const handlers = setup("b")
		expect(screen.getByTitle("b")).toHaveAttribute("aria-current", "true")
		expect(screen.queryByTitle("loose")).toBeNull()
		fireEvent.click(screen.getByTestId("one-view-strip-overflow"))
		expect(handlers.onToggleList).toHaveBeenCalledOnce()
	})
})
