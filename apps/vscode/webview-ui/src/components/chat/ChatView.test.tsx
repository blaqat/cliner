import type { ClineMessage } from "@shared/ExtensionMessage"
import type { HistoryItem } from "@shared/HistoryItem"
import { act, render, screen, within } from "@testing-library/react"
import { forwardRef, type ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import ChatView from "./ChatView"

const mocks = vi.hoisted(() => ({ state: {} as Record<string, unknown> }))

vi.mock("@/context/ExtensionStateContext", () => ({ useExtensionState: () => mocks.state }))
vi.mock("@/context/PlatformContext", () => ({
	usePlatform: () => ({ showNavbar: false }),
	useShowNavbar: () => false,
}))
// Every RPC resolves empty; streaming subscriptions just hand back an unsubscribe.
vi.mock("@/services/grpc-client", async (importOriginal) => {
	const client = new Proxy(
		{},
		{ get: (_, method) => (String(method).startsWith("subscribe") ? () => () => {} : vi.fn(async () => ({}))) },
	)
	const actual = await importOriginal<Record<string, unknown>>()
	return Object.fromEntries(Object.keys(actual).map((name) => [name, client]))
})
// jsdom has no layout, so Virtuoso would render nothing: render every row.
vi.mock("react-virtuoso", () => ({
	Virtuoso: forwardRef(
		({ data, itemContent }: { data: unknown[]; itemContent: (index: number, item: unknown) => ReactNode }, _ref) => (
			<div data-testid="chat-list">
				{data.map((item, index) => (
					<div data-index={index} key={index}>
						{itemContent(index, item)}
					</div>
				))}
			</div>
		),
	),
}))
vi.mock("./chat-view", async (importOriginal) => ({
	...(await importOriginal<typeof import("./chat-view")>()),
	ActionButtons: () => null,
	InputSection: () => null,
	QueuedPrompts: () => null,
	ThreadStrip: () => null,
}))

const firstMessage = "Refactor the auth middleware so tokens refresh in the background"
const say = (ts: number, sayType: ClineMessage["say"], extra: Partial<ClineMessage> = {}): ClineMessage => ({
	ts,
	type: "say",
	say: sayType,
	...extra,
})
const messages: ClineMessage[] = [
	say(1, "task", { text: firstMessage, images: ["data:image/png;base64,a"], files: ["/repo/auth.ts"] }),
	say(2, "text", { text: "On it." }),
	say(3, "user_feedback", { text: "Also cover expiry" }),
	say(4, "text", { text: "Done." }),
]
const item = (extra: Partial<HistoryItem> = {}): HistoryItem => ({
	id: "t1",
	ts: 1,
	task: firstMessage,
	tokensIn: 0,
	tokensOut: 0,
	totalCost: 0,
	...extra,
})

// Renders, then lets the mount-time RPCs settle.
const renderChat = async () => {
	render(<ChatView hideAnnouncement={vi.fn()} isHidden={false} showAnnouncement={false} showHistoryView={vi.fn()} />)
	await act(async () => {})
}

// The bubble of each user message, in list order.
const userBubbles = () => within(screen.getByTestId("chat-list")).getAllByTitle("Edit and regenerate from here")

describe("ChatView first message", () => {
	beforeEach(() => {
		vi.stubGlobal(
			"ResizeObserver",
			class {
				observe() {}
				unobserve() {}
				disconnect() {}
			},
		)
		mocks.state = {
			clineMessages: messages,
			currentTaskItem: item(),
			taskHistory: [item()],
			taskGroups: [],
			sessionStatuses: {},
			workspaceRoots: [],
			platform: "darwin",
			mode: "act",
			hooksEnabled: false,
			enableCheckpointsSetting: true,
			turnState: { phase: "completed", seq: 1 },
			apiConfiguration: {},
			navigateToSettings: vi.fn(),
		}
	})

	it.each([
		["without a title", undefined, firstMessage],
		["with a custom title", "Token refresh", "Token refresh"],
	])("renders the first message as the first user bubble %s", async (_, title, headerText) => {
		mocks.state = { ...mocks.state, currentTaskItem: item({ title }) }
		await renderChat()

		expect(screen.getByTestId("task-header-title-text")).toHaveTextContent(headerText)
		const bubbles = userBubbles()
		expect(bubbles.map((bubble) => bubble.textContent)).toEqual([
			expect.stringContaining(firstMessage),
			expect.stringContaining("Also cover expiry"),
		])
		// Same bubble as later messages, attachments included, and it's the list's first row.
		expect(within(bubbles[0]).getByAltText("Thumbnail image-1")).toBeInTheDocument()
		expect(within(bubbles[0]).getByText("auth.ts")).toBeInTheDocument()
		expect(bubbles[0].closest("[data-index]")).toHaveAttribute("data-index", "0")
		expect(bubbles[0].closest("[data-message-ts]")).toHaveAttribute("data-message-ts", "1")
	})

	it("counts the first message as the minimap's first user turn", async () => {
		vi.stubGlobal(
			"ResizeObserver",
			class {
				constructor(private callback: ResizeObserverCallback) {}
				observe() {
					this.callback([{ contentRect: { width: 400 } } as ResizeObserverEntry], this as unknown as ResizeObserver)
				}
				unobserve() {}
				disconnect() {}
			},
		)
		await renderChat()

		const squares = within(screen.getByTestId("chat-minimap")).getAllByRole("button")
		expect(squares.map((square) => square.dataset.kind)).toEqual(["user", "agent", "user", "agent"])
	})

	it("shows a subagent's prompt as its first bubble under the prompt header, without edit", async () => {
		mocks.state = {
			...mocks.state,
			currentTaskItem: item({ id: "t1__a", isSubagent: true, parentTaskId: "t1", task: firstMessage }),
			subagentView: { parentTaskId: "t1", agentId: "a", status: "done" },
		}
		await renderChat()

		expect(screen.getByTestId("subagent-thread-header")).toHaveTextContent(firstMessage)
		const list = screen.getByTestId("chat-list")
		expect(within(list).getByText(firstMessage).closest("[data-index]")).toHaveAttribute("data-index", "0")
		expect(within(list).queryByTitle("Edit and regenerate from here")).toBeNull()
	})
})
