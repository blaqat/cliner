import type { ClineMessage } from "@shared/ExtensionMessage"
import { act, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import SubagentStatusRow from "./SubagentStatusRow"
import { clearSubagentExpandTarget, emitSubagentExpand } from "./subagentExpand"

vi.mock("../common/MarkdownBlock", () => ({
	default: ({ markdown }: { markdown: string }) => <div>{markdown}</div>,
}))

const statusMessage = (ts: number): ClineMessage => ({
	ts,
	type: "say",
	say: "subagent",
	text: JSON.stringify({
		status: "completed",
		items: [
			{
				index: 1,
				prompt: "explore the repo",
				status: "completed",
				toolCalls: 3,
				inputTokens: 0,
				outputTokens: 0,
				totalCost: 0,
				contextTokens: 0,
				contextWindow: 0,
				contextUsagePercentage: 0,
				result: "SUBAGENT_RESULT_TEXT",
			},
		],
	}),
})

describe("SubagentStatusRow", () => {
	// The expand target is module-level state; reset between tests.
	afterEach(() => clearSubagentExpandTarget())

	it("expands a subagent's details on an expand request matching its ts", () => {
		render(<SubagentStatusRow isLast={false} message={statusMessage(42)} />)
		expect(screen.queryByText("SUBAGENT_RESULT_TEXT")).toBeNull()

		act(() => emitSubagentExpand(42, 1))
		expect(screen.getByText("SUBAGENT_RESULT_TEXT")).toBeTruthy()
	})

	it("ignores expand requests for other messages", () => {
		render(<SubagentStatusRow isLast={false} message={statusMessage(42)} />)
		act(() => emitSubagentExpand(43, 1))
		expect(screen.queryByText("SUBAGENT_RESULT_TEXT")).toBeNull()
	})

	it("expands a row that was not mounted when the expand request was emitted", () => {
		// Simulates a chip click whose status row is outside Virtuoso's rendered
		// range: the request persists until the row mounts and consumes it.
		act(() => emitSubagentExpand(42, 1))
		render(<SubagentStatusRow isLast={false} message={statusMessage(42)} />)
		expect(screen.getByText("SUBAGENT_RESULT_TEXT")).toBeTruthy()
	})

	it("clears the pending target once a row consumes it", () => {
		act(() => emitSubagentExpand(42, 1))
		const first = render(<SubagentStatusRow isLast={false} message={statusMessage(42)} />)
		expect(screen.getByText("SUBAGENT_RESULT_TEXT")).toBeTruthy()
		first.unmount()

		// A later-mounted row for the same message must not re-expand.
		render(<SubagentStatusRow isLast={false} message={statusMessage(42)} />)
		expect(screen.queryByText("SUBAGENT_RESULT_TEXT")).toBeNull()
	})

	it("does not expand after the pending target is cleared (task switch)", () => {
		act(() => emitSubagentExpand(42, 1))
		act(() => clearSubagentExpandTarget())
		render(<SubagentStatusRow isLast={false} message={statusMessage(42)} />)
		expect(screen.queryByText("SUBAGENT_RESULT_TEXT")).toBeNull()
	})
})
