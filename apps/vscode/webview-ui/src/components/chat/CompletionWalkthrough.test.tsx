import type { ClineMessage } from "@shared/ExtensionMessage"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ChatRowContent } from "./ChatRow"

const mocks = vi.hoisted(() => ({
	count: vi.fn(),
	navigateToWalkthrough: vi.fn(),
	isSubagent: false,
}))

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({
		currentTaskItem: { id: "task-1", isSubagent: mocks.isSubagent },
		clineMessages: [],
		mcpServers: [],
		turnState: undefined,
		enableCheckpointsSetting: true,
		showFeatureTips: false,
		navigateToSettings: vi.fn(),
		navigateToWalkthrough: mocks.navigateToWalkthrough,
	}),
}))
vi.mock("@/services/grpc-client", () => ({
	TaskServiceClient: { buildMessageLink: vi.fn() },
	CheckpointsServiceClient: {
		checkpointLatestChangesCount: (...args: unknown[]) => mocks.count(...args),
		checkpointViewLatestChanges: vi.fn(() => Promise.resolve({})),
	},
	StateServiceClient: { togglePlanActModeProto: vi.fn() },
}))
vi.mock("./MarkdownRow", () => ({
	MarkdownRow: ({ markdown }: { markdown: string }) => <div>{markdown}</div>,
}))
// SuccessButton renders a VSCodeButton; a native button keeps it visible to role queries.
vi.mock("@vscode/webview-ui-toolkit/react", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	VSCodeButton: ({ children, onClick }: { children?: React.ReactNode; onClick?: () => void }) => (
		<button onClick={onClick} type="button">
			{children}
		</button>
	),
}))

const completion: ClineMessage = { ts: 7, type: "say", say: "completion_result", text: "Done.", partial: false }

const renderRow = (isLast = true) =>
	render(
		<ChatRowContent
			inputValue=""
			isExpanded={false}
			isLast={isLast}
			lastModifiedMessage={undefined}
			message={completion}
			mode="act"
			onSetQuote={vi.fn()}
			onToggleExpand={vi.fn()}
			sendMessageFromChatRow={vi.fn()}
		/>,
	)

describe("Open walkthrough on the completion block", () => {
	beforeEach(() => {
		mocks.count.mockReset()
		mocks.navigateToWalkthrough.mockReset()
		mocks.isSubagent = false
	})

	it("is called out beside View Changes when the turn changed files, and opens the page", async () => {
		mocks.count.mockResolvedValue({ value: 3 })
		renderRow()
		const button = await screen.findByTestId("completion-open-walkthrough")
		expect(button).toHaveAccessibleName("Open walkthrough")
		expect(button.querySelector(".codicon-diff")).not.toBeNull()
		expect(screen.getByRole("button", { name: /View Changes/ })).toBeVisible()
		fireEvent.click(button)
		expect(mocks.navigateToWalkthrough).toHaveBeenCalledTimes(1)
		// No click event as the authored id: it can't be serialized and broke the page.
		expect(mocks.navigateToWalkthrough).toHaveBeenCalledWith()
	})

	it("stays hidden when the turn changed no files", async () => {
		mocks.count.mockResolvedValue({ value: 0 })
		renderRow()
		await waitFor(() => expect(mocks.count).toHaveBeenCalled())
		expect(screen.queryByTestId("completion-open-walkthrough")).toBeNull()
	})

	it("stays hidden on earlier completion blocks", () => {
		mocks.count.mockResolvedValue({ value: 3 })
		renderRow(false)
		expect(mocks.count).not.toHaveBeenCalled()
		expect(screen.queryByTestId("completion-open-walkthrough")).toBeNull()
	})

	it("stays hidden in subagent threads, even with changes", async () => {
		mocks.isSubagent = true
		mocks.count.mockResolvedValue({ value: 3 })
		renderRow()
		await screen.findByRole("button", { name: /View Changes/ })
		expect(screen.queryByTestId("completion-open-walkthrough")).toBeNull()
	})
})
