import type { HistoryItem } from "@shared/HistoryItem"
import { fireEvent, render, screen, within } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ThreadTagRow } from "./ThreadTagRow"

const mocks = vi.hoisted(() => ({ setThreadTags: vi.fn(), state: {} as Record<string, unknown> }))

vi.mock("@/context/ExtensionStateContext", () => ({ useExtensionState: () => mocks.state }))
vi.mock("@/services/grpc-client", () => ({
	TaskServiceClient: { setThreadTags: (request: unknown) => mocks.setThreadTags(request) },
}))

const thread: HistoryItem = {
	id: "t",
	ts: 1,
	task: "thread",
	tokensIn: 0,
	tokensOut: 0,
	totalCost: 0,
	taskGroupId: "g",
	tags: [{ kind: "label", value: "mine", source: "user" }],
}

describe("ThreadTagRow inherited tags", () => {
	beforeEach(() => {
		mocks.setThreadTags.mockReset().mockResolvedValue({})
		mocks.state = {
			taskHistory: [thread],
			taskGroups: [
				{
					id: "g",
					title: "Export",
					tags: [
						{ kind: "ticket", value: "PROJ-1", source: "user" },
						{ kind: "branch", value: "feat/x", source: "user" },
					],
					createdAt: 0,
					updatedAt: 0,
					noteCount: 0,
				},
			],
		}
	})

	it("shows the task's tags first, muted, with a tooltip and no remove button", () => {
		render(<ThreadTagRow item={thread} />)

		const chips = screen.getAllByTestId("task-tag-chip")
		expect(chips.map((chip) => chip.textContent)).toEqual(["PROJ-1", "feat/x", "mine×"])
		expect(chips[0]).toHaveAttribute("title", "From task Export")
		expect(chips[0]).toHaveAttribute("data-inherited", "true")
		expect(within(chips[0]).queryByRole("button")).toBeNull()
		expect(within(chips[2]).getByRole("button", { name: "Remove tag mine" })).toBeInTheDocument()
		expect(screen.getAllByRole("button", { name: /Remove tag/ })).toHaveLength(1)
	})

	it("hides the branch suggestion when the task already has that branch", () => {
		render(<ThreadTagRow currentBranch="feat/x" item={thread} />)

		expect(screen.queryByRole("button", { name: "Add branch tag feat/x" })).toBeNull()
	})

	it("still suggests a branch neither the thread nor its task has, and saves only own tags", () => {
		render(<ThreadTagRow currentBranch="other" item={thread} />)

		fireEvent.click(screen.getByRole("button", { name: "Add branch tag other" }))

		const request = mocks.setThreadTags.mock.calls[0][0]
		expect(request.tags.map((t: { value: string }) => t.value)).toEqual(["mine", "other"])
	})
})
