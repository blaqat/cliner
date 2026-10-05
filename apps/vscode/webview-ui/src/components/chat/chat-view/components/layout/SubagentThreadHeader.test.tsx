import type { HistoryItem } from "@shared/HistoryItem"
import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { SubagentThreadFooter, SubagentThreadHeader } from "./SubagentThreadHeader"

const mocks = vi.hoisted(() => ({ openTask: vi.fn(), stopSubagent: vi.fn() }))
vi.mock("@/components/inbox/sessionActions", () => mocks)
const item: HistoryItem = {
	id: "parent__child",
	ts: 1,
	task: "Write a full report",
	tokensIn: 0,
	tokensOut: 0,
	totalCost: 0,
	isSubagent: true,
}

describe("subagent thread controls", () => {
	it("links back to the parent and allows stopping only while the child is live", () => {
		const view = { parentTaskId: "parent", agentId: "child", status: "running" as const }
		const { rerender } = render(<SubagentThreadHeader item={item} view={view} />)
		fireEvent.click(screen.getByRole("button", { name: "Back to parent" }))
		expect(mocks.openTask).toHaveBeenCalledWith("parent")
		fireEvent.click(screen.getByRole("button", { name: "Stop subagent" }))
		expect(mocks.stopSubagent).toHaveBeenCalledWith("parent", item.id)
		rerender(<SubagentThreadHeader item={item} view={{ ...view, status: "done" }} />)
		expect(screen.queryByRole("button", { name: "Stop subagent" })).toBeNull()
	})

	it("explains read-only behavior and quotes the report without sending a followup", () => {
		const onQuote = vi.fn()
		const { rerender } = render(<SubagentThreadFooter hasReport={false} onQuote={onQuote} />)
		expect(screen.getByText(/read-only/)).toBeInTheDocument()
		expect(screen.getByRole("button", { name: "Quote into parent" })).toBeDisabled()
		rerender(<SubagentThreadFooter hasReport onQuote={onQuote} />)
		fireEvent.click(screen.getByRole("button", { name: "Quote into parent" }))
		expect(onQuote).toHaveBeenCalledOnce()
		expect(screen.queryByRole("textbox")).toBeNull()
	})
})

it("navigates from B to immediate parent A while Stop addresses the saved child", () => {
	const b = { ...item, id: "root__b", parentTaskId: "root__a", runtimeOwnerTaskId: "root" }
	render(<SubagentThreadHeader item={b} view={{ parentTaskId: "root__a", agentId: "b", status: "running" }} />)
	fireEvent.click(screen.getByRole("button", { name: "Back to parent" }))
	expect(mocks.openTask).toHaveBeenLastCalledWith("root__a")
	fireEvent.click(screen.getByRole("button", { name: "Stop subagent" }))
	expect(mocks.stopSubagent).toHaveBeenLastCalledWith("root__a", "root__b")
})
