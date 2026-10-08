import type { ClineMessage } from "@shared/ExtensionMessage"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { SubagentDecisionControls } from "./SubagentDecisionControls"

const mocks = vi.hoisted(() => ({ state: {} as Record<string, unknown>, askResponse: vi.fn() }))
vi.mock("@/context/ExtensionStateContext", () => ({ useExtensionState: () => mocks.state }))
vi.mock("@/services/grpc-client", () => ({ TaskServiceClient: { askResponse: mocks.askResponse } }))
const a: ClineMessage = { ts: 1, type: "ask", ask: "tool", decisionId: "decision-a", subagentTaskId: "child-a" }
const b: ClineMessage = { ts: 2, type: "ask", ask: "followup", decisionId: "decision-b", subagentTaskId: "child-b" }

describe("SubagentDecisionControls", () => {
	beforeEach(() => {
		mocks.askResponse.mockReset().mockResolvedValue({})
		mocks.state = {
			currentTaskItem: { id: "parent" },
			pendingSubagentDecisions: [
				{ taskId: "child-a", name: "Review auth", kind: "approval", message: a },
				{ taskId: "child-b", name: "Check routes", kind: "question", message: b },
			],
		}
	})
	it("scopes approval and rejection to the displayed child from the parent", async () => {
		render(<SubagentDecisionControls message={a} />)
		fireEvent.click(screen.getByRole("button", { name: "Approve Review auth" }))
		await waitFor(() =>
			expect(mocks.askResponse).toHaveBeenCalledWith(
				expect.objectContaining({ taskId: "parent", decisionId: "decision-a", responseType: "yesButtonClicked" }),
			),
		)
		await waitFor(() => expect(screen.getByRole("button", { name: "Reject Review auth" })).toBeEnabled())
		fireEvent.click(screen.getByRole("button", { name: "Reject Review auth" }))
		await waitFor(() =>
			expect(mocks.askResponse).toHaveBeenLastCalledWith(
				expect.objectContaining({ decisionId: "decision-a", responseType: "noButtonClicked" }),
			),
		)
	})
	it("answers a sibling question while an approval is pending", async () => {
		render(<SubagentDecisionControls message={b} />)
		fireEvent.change(screen.getByRole("textbox", { name: "Answer Check routes" }), { target: { value: "Use option one" } })
		fireEvent.click(screen.getByRole("button", { name: "Answer" }))
		await waitFor(() =>
			expect(mocks.askResponse).toHaveBeenCalledWith(
				expect.objectContaining({
					taskId: "parent",
					decisionId: "decision-b",
					responseType: "messageResponse",
					text: "Use option one",
				}),
			),
		)
	})
	it("removes controls when a decision resolves and keeps a failed response retryable", async () => {
		mocks.askResponse.mockRejectedValueOnce(new Error("Disconnected"))
		const { rerender } = render(<SubagentDecisionControls compact message={a} />)
		fireEvent.click(screen.getByRole("button", { name: "Approve Review auth" }))
		await screen.findByRole("alert")
		expect(screen.getByRole("button", { name: "Approve Review auth" })).toBeEnabled()
		mocks.state.pendingSubagentDecisions = []
		rerender(<SubagentDecisionControls compact message={a} />)
		expect(screen.queryByRole("button")).toBeNull()
	})
})
