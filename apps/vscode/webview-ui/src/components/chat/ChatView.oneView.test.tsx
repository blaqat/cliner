import type { ClineMessage } from "@shared/ExtensionMessage"
import type { HistoryItem } from "@shared/HistoryItem"
import { act, fireEvent, render, screen } from "@testing-library/react"
import { forwardRef, type ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import ChatView from "./ChatView"

const mocks = vi.hoisted(() => ({ state: {} as Record<string, unknown>, showTaskWithId: vi.fn() }))

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
	const clients = Object.fromEntries(Object.keys(actual).map((name) => [name, client]))
	// Opening a thread is what Esc in an empty new chat does; record it.
	const taskClient = new Proxy(
		{},
		{
			get: (_, method) =>
				method === "showTaskWithId"
					? (request: unknown) => {
							mocks.showTaskWithId(request)
							return Promise.resolve({})
						}
					: (client as Record<string | symbol, unknown>)[method],
		},
	)
	return { ...clients, TaskServiceClient: taskClient }
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

describe("ChatView one view", () => {
	beforeEach(() => {
		const store = new Map<string, string>()
		vi.stubGlobal("localStorage", {
			getItem: (key: string) => store.get(key) ?? null,
			setItem: (key: string, value: string) => void store.set(key, value),
			removeItem: (key: string) => void store.delete(key),
		})
		vi.stubGlobal(
			"ResizeObserver",
			class {
				constructor(private callback: ResizeObserverCallback) {}
				observe() {
					this.callback([{ contentRect: { width: 900 } } as ResizeObserverEntry], this as unknown as ResizeObserver)
				}
				unobserve() {}
				disconnect() {}
			},
		)
		mocks.showTaskWithId.mockReset()
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
			hideTaskGroupView: vi.fn(),
		}
	})

	it("keeps the classic layout when the setting is off", async () => {
		await renderChat()
		expect(screen.queryByTestId("one-view")).toBeNull()
		expect(screen.getByTestId("crumb-home")).toBeInTheDocument()
		expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument()
	})

	it("shows the list beside the thread and a header without the Home crumb", async () => {
		mocks.state = { ...mocks.state, oneViewEnabled: true }
		await renderChat()
		expect(screen.getByTestId("one-view")).toHaveAttribute("data-placement", "left")
		expect(screen.getByTestId("one-view-side")).toBeInTheDocument()
		expect(screen.queryByTestId("crumb-home")).toBeNull()
		expect(screen.queryByRole("button", { name: "Close" })).toBeNull()
		const header = screen.getByTestId("task-header")
		expect(header.firstElementChild).toBe(screen.getByTestId("one-view-list-toggle"))
		expect(screen.getByTestId("task-header-title-text")).toHaveTextContent(firstMessage)
		// The open thread is the highlighted row.
		expect(screen.getByTestId("one-view-row")).toHaveAttribute("aria-current", "true")
	})

	it("opens a new chat (small logo and prompt) instead of the home page, and Esc goes back to the thread", async () => {
		mocks.state = { ...mocks.state, oneViewEnabled: true }
		const { rerender } = render(
			<ChatView hideAnnouncement={vi.fn()} isHidden={false} showAnnouncement={false} showHistoryView={vi.fn()} />,
		)
		await act(async () => {})
		mocks.state = { ...mocks.state, clineMessages: [], currentTaskItem: undefined }
		rerender(<ChatView hideAnnouncement={vi.fn()} isHidden={false} showAnnouncement={false} showHistoryView={vi.fn()} />)
		await act(async () => {})
		expect(screen.getByTestId("one-view-new-chat-hero")).toHaveTextContent("What should Cline do?")
		expect(screen.queryByTestId("home-search-bar")).toBeNull()
		const surface = screen.getByTestId("one-view-new-chat").parentElement as HTMLElement
		fireEvent.keyDown(surface, { key: "Escape" })
		expect(mocks.showTaskWithId).toHaveBeenCalledWith(expect.objectContaining({ value: "t1" }))
	})

	it("doesn't leave a new chat on Esc when there's no earlier thread", async () => {
		mocks.state = { ...mocks.state, oneViewEnabled: true, clineMessages: [], currentTaskItem: undefined }
		await renderChat()
		const surface = screen.getByTestId("one-view-new-chat").parentElement as HTMLElement
		fireEvent.keyDown(surface, { key: "Escape" })
		expect(mocks.showTaskWithId).not.toHaveBeenCalled()
	})
})
