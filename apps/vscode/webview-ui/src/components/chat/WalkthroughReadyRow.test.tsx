import type { ClineMessage } from "@shared/ExtensionMessage"
import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ChatRowContent } from "./ChatRow"
import { parseWalkthroughReady } from "./WalkthroughReadyRow"

const mocks = vi.hoisted(() => ({
	navigateToWalkthrough: vi.fn(),
	openUrl: vi.fn(() => Promise.resolve({})),
}))

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({
		currentTaskItem: { id: "task-1" },
		clineMessages: [],
		mcpServers: [],
		navigateToWalkthrough: mocks.navigateToWalkthrough,
	}),
}))
vi.mock("@/services/grpc-client", () => ({
	UiServiceClient: { openUrl: (...args: unknown[]) => mocks.openUrl(...args) },
	FileServiceClient: {},
	StateServiceClient: {},
	TaskServiceClient: { buildMessageLink: vi.fn() },
	CheckpointsServiceClient: {},
}))
vi.mock("./MarkdownRow", () => ({
	MarkdownRow: ({ markdown }: { markdown: string }) => <div>{markdown}</div>,
}))

const ready = (text: string): ClineMessage => ({ ts: 9, type: "say", say: "walkthrough_ready", text, partial: false })

const payload = {
	authoredId: "walk-1",
	title: "Review: retry on checkout timeouts",
	origin: { label: "GitLab MR !128", url: "https://gitlab.example.com/team/app/-/merge_requests/128" },
	stopCount: 5,
	fileCount: 3,
}

const renderRow = (text: string) =>
	render(
		<ChatRowContent
			inputValue=""
			isExpanded={false}
			isLast={false}
			lastModifiedMessage={undefined}
			message={ready(text)}
			mode="act"
			onSetQuote={vi.fn()}
			onToggleExpand={vi.fn()}
			sendMessageFromChatRow={vi.fn()}
		/>,
	)

describe("walkthrough_ready card", () => {
	beforeEach(() => {
		mocks.navigateToWalkthrough.mockReset()
		mocks.openUrl.mockClear()
	})

	it("renders the title, origin link and counts, and opens the authored walkthrough", () => {
		renderRow(JSON.stringify(payload))
		const card = screen.getByTestId("walkthrough-ready")
		expect(card).toHaveTextContent("Review: retry on checkout timeouts")
		expect(card).toHaveTextContent("5 stops · 3 files")

		const link = screen.getByRole("button", { name: "GitLab MR !128" })
		fireEvent.click(link)
		expect(mocks.openUrl).toHaveBeenCalledTimes(1)
		expect(mocks.openUrl.mock.calls[0][0]).toEqual({ value: payload.origin.url })

		const open = screen.getByRole("button", { name: "Open walkthrough" })
		expect(open.querySelector(".codicon-diff")).not.toBeNull()
		fireEvent.click(open)
		expect(mocks.navigateToWalkthrough).toHaveBeenCalledWith("walk-1")
	})

	it("renders the origin as plain text when it has no URL", () => {
		renderRow(JSON.stringify({ ...payload, origin: { label: "pasted diff" } }))
		expect(screen.getByTestId("walkthrough-ready")).toHaveTextContent("pasted diff")
		expect(screen.queryByRole("button", { name: "pasted diff" })).toBeNull()
	})

	it("renders nothing for a malformed payload", () => {
		const { container } = renderRow("not json")
		expect(container.querySelector("[data-testid='walkthrough-ready']")).toBeNull()
	})
})

describe("parseWalkthroughReady", () => {
	it("accepts the contract payload and drops malformed fields", () => {
		expect(parseWalkthroughReady(JSON.stringify(payload))).toEqual(payload)
		expect(parseWalkthroughReady(JSON.stringify({ authoredId: "w", stopCount: "2" }))).toEqual({
			authoredId: "w",
			title: "Walkthrough",
			origin: undefined,
			stopCount: 0,
			fileCount: 0,
		})
	})

	it("rejects missing or empty authoredId", () => {
		expect(parseWalkthroughReady(JSON.stringify({ title: "x" }))).toBeNull()
		expect(parseWalkthroughReady(JSON.stringify({ authoredId: "" }))).toBeNull()
		expect(parseWalkthroughReady(undefined)).toBeNull()
	})
})
