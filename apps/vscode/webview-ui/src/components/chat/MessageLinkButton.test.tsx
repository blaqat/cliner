import type { ClineMessage } from "@shared/ExtensionMessage"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ChatRowContent } from "./ChatRow"
import { CompletionOutputRow } from "./CompletionOutputRow"
import MessageLinkButton from "./MessageLinkButton"
import PlanCompletionOutputRow from "./PlanCompletionOutputRow"
import UserMessage from "./UserMessage"

const buildMessageLink = vi.fn()

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({
		currentTaskItem: { id: "task-1" },
		clineMessages: [],
		mcpServers: [],
		turnState: undefined,
		enableCheckpointsSetting: false,
		showFeatureTips: false,
		navigateToSettings: vi.fn(),
		navigateToWalkthrough: vi.fn(),
	}),
}))

vi.mock("@/services/grpc-client", () => ({
	TaskServiceClient: { buildMessageLink: (request: unknown) => buildMessageLink(request) },
	CheckpointsServiceClient: {
		checkpointLatestChangesCount: vi.fn(() => Promise.resolve({ value: 0 })),
		checkpointViewLatestChanges: vi.fn(() => Promise.resolve({})),
	},
	StateServiceClient: { togglePlanActModeProto: vi.fn(() => Promise.resolve({ value: true })) },
}))

vi.mock("./MarkdownRow", () => ({
	MarkdownRow: ({ markdown }: { markdown: string }) => <div>{markdown}</div>,
}))
vi.mock("@/components/common/MarkdownBlock", () => ({
	default: ({ markdown }: { markdown: string }) => <div>{markdown}</div>,
}))

const URL = "vscode://saoudrizwan.cliner/thread/task-1?m=3&t=call_done"
const hiddenQuote = { visible: false, top: 0, left: 0, selectedText: "" }
const linkButton = () => screen.getByTestId("message-link-button")

describe("MessageLinkButton", () => {
	const writeText = vi.fn()

	beforeEach(() => {
		buildMessageLink.mockReset().mockResolvedValue({ url: URL })
		writeText.mockReset().mockResolvedValue(undefined)
		Object.assign(navigator, { clipboard: { writeText } })
	})
	afterEach(() => vi.restoreAllMocks())

	it("asks the host for the row's link, copies it and shows Copied", async () => {
		render(<MessageLinkButton messageTs={42} />)
		expect(linkButton()).toHaveAccessibleName("Copy link to this message")

		fireEvent.click(linkButton())

		await waitFor(() => expect(writeText).toHaveBeenCalledWith(URL))
		expect(buildMessageLink).toHaveBeenCalledWith(expect.objectContaining({ threadId: "task-1", messageTs: 42 }))
		await waitFor(() => expect(linkButton()).toHaveAccessibleName("Copied"))
	})

	it("falls back to a selection copy when the clipboard API refuses", async () => {
		writeText.mockRejectedValue(new Error("denied"))
		const execCommand = vi.fn(() => true)
		Object.assign(document, { execCommand })
		render(<MessageLinkButton messageTs={42} />)

		fireEvent.click(linkButton())

		await waitFor(() => expect(execCommand).toHaveBeenCalledWith("copy"))
		await waitFor(() => expect(linkButton()).toHaveAccessibleName("Copied"))
	})

	it("says so when the link can't be built instead of doing nothing", async () => {
		buildMessageLink.mockRejectedValue(new Error("That message has no transcript position to link to yet"))
		vi.spyOn(console, "error").mockImplementation(() => {})
		render(<MessageLinkButton messageTs={42} />)

		fireEvent.click(linkButton())

		await waitFor(() => expect(linkButton()).toHaveAccessibleName("Couldn't copy link"))
		expect(writeText).not.toHaveBeenCalled()
	})

	it("says so when nothing can write to the clipboard", async () => {
		writeText.mockRejectedValue(new Error("denied"))
		Object.assign(document, { execCommand: vi.fn(() => false) })
		vi.spyOn(console, "error").mockImplementation(() => {})
		render(<MessageLinkButton messageTs={42} />)

		fireEvent.click(linkButton())

		await waitFor(() => expect(linkButton()).toHaveAccessibleName("Couldn't copy link"))
	})
})

// Every row type that shows Copy link must hand its own ts to the host and copy what comes back.
describe("Copy link on each row type", () => {
	const writeText = vi.fn()

	beforeEach(() => {
		buildMessageLink.mockReset().mockResolvedValue({ url: URL })
		writeText.mockReset().mockResolvedValue(undefined)
		Object.assign(navigator, { clipboard: { writeText } })
	})

	async function copyLink(ts: number) {
		fireEvent.click(linkButton())
		await waitFor(() => expect(writeText).toHaveBeenCalledWith(URL))
		expect(buildMessageLink).toHaveBeenCalledWith(expect.objectContaining({ threadId: "task-1", messageTs: ts }))
		await waitFor(() => expect(linkButton()).toHaveAccessibleName("Copied"))
	}

	it("completion block (attempt_completion / submit_and_exit result)", async () => {
		render(
			<CompletionOutputRow asideFromTs={101} handleQuoteClick={vi.fn()} quoteButtonState={hiddenQuote} text="All done" />,
		)
		await copyLink(101)
	})

	it("Ask-mode answer block", async () => {
		render(
			<PlanCompletionOutputRow asideFromTs={102} handleQuoteClick={vi.fn()} quoteButtonState={hiddenQuote} text="Plan" />,
		)
		await copyLink(102)
	})

	it("user message", async () => {
		render(<UserMessage messageTs={103} text="Fix the loop" />)
		await copyLink(103)
	})

	const renderRow = (message: ClineMessage) =>
		render(
			<ChatRowContent
				inputValue=""
				isExpanded={false}
				isLast={false}
				lastModifiedMessage={undefined}
				message={message}
				mode="act"
				onSetQuote={vi.fn()}
				onToggleExpand={vi.fn()}
				sendMessageFromChatRow={vi.fn()}
			/>,
		)

	it("agent text row", async () => {
		renderRow({ ts: 104, type: "say", say: "text", text: "I will look.", partial: false })
		await copyLink(104)
	})

	it("completion row (say: completion_result)", async () => {
		renderRow({ ts: 105, type: "say", say: "completion_result", text: "Finished.", partial: false })
		await copyLink(105)
	})

	it("Ask-mode answer row (say: plan_completion_result)", async () => {
		renderRow({ ts: 106, type: "say", say: "plan_completion_result", text: "Here is the plan.", partial: false })
		await copyLink(106)
	})

	it("follow-up question row", async () => {
		renderRow({ ts: 107, type: "ask", ask: "followup", text: JSON.stringify({ question: "Which module?" }), partial: false })
		await copyLink(107)
	})
})
