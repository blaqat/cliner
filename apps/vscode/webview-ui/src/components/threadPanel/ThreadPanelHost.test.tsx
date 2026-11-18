import type { ClineMessage } from "@shared/ExtensionMessage"
import type { HistoryItem } from "@shared/HistoryItem"
import { WRAP_UP_PROMPT } from "@shared/sideThreads"
import { act, fireEvent, render, screen, within } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { SideQuestionCard } from "@/components/sideThreads/SideThreadCards"
import { getSideThreadSlots, resetSideThreadSlots, showBeside, showQuestion } from "@/components/sideThreads/sideThreadStore"
import { type ThreadPanelData, ThreadPanelHost, ThreadPanelLine } from "./ThreadPanelHost"
import { reloadThreadPanelPrefs } from "./threadPanelPrefs"

const mocks = vi.hoisted(() => ({
	state: {} as Record<string, unknown>,
	width: 900,
	rpc: {
		sendToSideThread: vi.fn(async (_request: unknown) => ({})),
		sendSideThreadNote: vi.fn(async (_request: unknown) => ({})),
		updateSideThread: vi.fn(async (_request: unknown) => ({})),
		showTaskWithId: vi.fn(async (_request: unknown) => ({})),
	},
}))

vi.mock("@/context/ExtensionStateContext", () => ({ useExtensionState: () => mocks.state }))
vi.mock("@/services/grpc-client", () => ({
	SideThreadServiceClient: {
		sendToSideThread: (request: unknown) => mocks.rpc.sendToSideThread(request),
		sendSideThreadNote: (request: unknown) => mocks.rpc.sendSideThreadNote(request),
		updateSideThread: (request: unknown) => mocks.rpc.updateSideThread(request),
	},
	TaskServiceClient: { showTaskWithId: (request: unknown) => mocks.rpc.showTaskWithId(request) },
}))
vi.mock("@/components/chat/composer/ContextUsageIndicator", () => ({
	AUTO_COMPACT_PERCENT: 90,
	useComposerContextUsage: () => ({ contextWindow: 1_000_000 }),
}))
vi.mock("@/components/worktrees/useWorktree", () => ({
	useWorktree: () => ({ state: undefined }),
	threadWorktreeAction: vi.fn(async () => ({})),
}))
vi.mock("@/components/chat/composer/BranchTaskSuggestion", () => ({ useBranchTaskSuggestion: () => undefined }))
vi.mock("@/components/common/MarkdownBlock", () => ({ default: ({ markdown }: { markdown?: string }) => <p>{markdown}</p> }))

const item = (id: string, fields: Partial<HistoryItem> = {}): HistoryItem => ({
	id,
	ts: Date.now() - 60_000,
	task: id,
	tokensIn: 0,
	tokensOut: 0,
	totalCost: 0,
	...fields,
})

const main = item("main", { task: "Fix flaky dispatcher test" })
const side = item("side", { parentTaskId: "main", task: "Is 500ms too short?", sideKind: "side" })
const closed = item("closed", { parentTaskId: "main", task: "Compare with the Go client", sideClosedAt: 5 })
const edit: ClineMessage = {
	ts: 2,
	type: "say",
	say: "tool",
	text: JSON.stringify({ tool: "editedExistingFile", path: "WebhookDispatcher.java" }),
}

const data: ThreadPanelData = {
	item: main,
	messages: [edit],
	usage: { totalCost: 1.84, lastApiReqTotalTokens: 412_000 },
	onNewSideThread: vi.fn(),
}

function renderPanel() {
	return render(
		<ThreadPanelHost data={data}>
			<ThreadPanelLine />
			<div>chat</div>
		</ThreadPanelHost>,
	)
}

describe("thread panel", () => {
	beforeEach(() => {
		const store = new Map<string, string>()
		vi.stubGlobal("localStorage", {
			getItem: (key: string) => store.get(key) ?? null,
			setItem: (key: string, value: string) => void store.set(key, value),
		})
		vi.stubGlobal(
			"ResizeObserver",
			class {
				constructor(private callback: ResizeObserverCallback) {}
				observe() {
					this.callback(
						[{ contentRect: { width: mocks.width } } as ResizeObserverEntry],
						this as unknown as ResizeObserver,
					)
				}
				unobserve() {}
				disconnect() {}
			},
		)
		reloadThreadPanelPrefs()
		resetSideThreadSlots()
		for (const fn of Object.values(mocks.rpc)) fn.mockClear()
		mocks.width = 900
		mocks.state = {
			currentTaskItem: main,
			taskHistory: [main, side, closed],
			sessionStatuses: { side: "running" },
			clineMessages: [edit],
			mode: "act",
			currentBranch: "main",
			taskGroups: [],
			sideThreadViews: [],
			navigateToWalkthrough: vi.fn(),
			navigateToTaskGroup: vi.fn(),
		}
	})

	it("is a column beside the chat when wide, with every section; hiding it leaves the line to bring it back", () => {
		renderPanel()
		const column = screen.getByTestId("thread-panel-column")
		expect(within(column).getByText("This thread")).toBeInTheDocument()
		expect(
			within(column)
				.getAllByTestId("thread-panel-section")
				.map((section) => section.dataset.section),
		).toEqual(["where", "agents", "notes", "context"])
		expect(within(column).getByText("412k / 1m")).toBeInTheDocument()
		expect(within(column).getByText("$1.84")).toBeInTheDocument()
		expect(screen.queryByTestId("thread-panel-line")).toBeNull()
		expect(getSideThreadSlots().room).toBe(true)

		fireEvent.click(screen.getByRole("button", { name: "Hide the thread panel" }))
		expect(screen.queryByTestId("thread-panel-column")).toBeNull()
		fireEvent.click(screen.getByTestId("thread-panel-summary"))
		expect(screen.getByTestId("thread-panel-column")).toBeInTheDocument()
	})

	it("is a summary line when narrow that opens the panel in place, and Esc closes it", () => {
		mocks.width = 400
		renderPanel()
		expect(screen.queryByTestId("thread-panel-column")).toBeNull()
		expect(getSideThreadSlots().room).toBe(false)
		const summary = screen.getByTestId("thread-panel-summary")
		expect(summary).toHaveTextContent("1 file")
		expect(summary).toHaveTextContent("41%")
		fireEvent.click(summary)
		expect(summary).toHaveAttribute("aria-expanded", "true")
		const drawer = screen.getByTestId("thread-panel-drawer")
		fireEvent.keyDown(drawer, { key: "Escape" })
		expect(screen.queryByTestId("thread-panel-drawer")).toBeNull()
	})

	it("lets the user choose which sections show, remembered, and never leaves it empty without a way back", () => {
		const { unmount } = renderPanel()
		// The menu stays open while you pick, like a checklist.
		fireEvent.click(screen.getByTestId("thread-panel-sections-menu"))
		for (const label of ["Branch & changes", "Agents", "Notes", "Context & cost"]) {
			fireEvent.click(screen.getByRole("menuitemcheckbox", { name: label }))
		}
		expect(screen.getByText("Every section is turned off.")).toBeInTheDocument()
		unmount()
		reloadThreadPanelPrefs()
		renderPanel()
		expect(screen.getByText("Every section is turned off.")).toBeInTheDocument()
		fireEvent.click(screen.getByRole("button", { name: "Show all sections" }))
		expect(screen.getAllByTestId("thread-panel-section")).toHaveLength(4)
	})

	it("lists side threads with live status; closed ones wait behind Show more", () => {
		renderPanel()
		const rows = screen.getAllByTestId("agent-row")
		expect(rows).toHaveLength(1)
		expect(rows[0]).toHaveTextContent("Is 500ms too short?")
		expect(rows[0]).toHaveTextContent("running")
		fireEvent.click(screen.getByRole("button", { name: "Show 1 more" }))
		expect(screen.getAllByTestId("agent-row")[1]).toHaveTextContent("closed")
		fireEvent.click(screen.getByRole("button", { name: /New side thread/ }))
		expect(data.onNewSideThread).toHaveBeenCalled()
	})

	it("opens a side thread beside Main in the column, sends to it, and wraps up with a note you approve", async () => {
		renderPanel()
		fireEvent.click(screen.getByRole("button", { name: "Open side thread Is 500ms too short?" }))
		expect(getSideThreadSlots().beside).toEqual({ main: "side" })
		expect(mocks.rpc.showTaskWithId).not.toHaveBeenCalled()
		const column = screen.getByTestId("side-thread-column")
		const input = within(column).getByRole("textbox", { name: "Message the side thread" })
		fireEvent.change(input, { target: { value: "And with jitter?" } })
		await act(async () => {
			fireEvent.keyDown(input, { key: "Enter" })
		})
		expect(mocks.rpc.sendToSideThread).toHaveBeenCalledWith(
			expect.objectContaining({ threadId: "side", text: "And with jitter?" }),
		)

		await act(async () => {
			fireEvent.click(within(column).getByTestId("wrap-up-button"))
		})
		expect(mocks.rpc.sendToSideThread).toHaveBeenLastCalledWith(expect.objectContaining({ text: WRAP_UP_PROMPT }))
		expect(screen.getByText("Drafting a note for main…")).toBeInTheDocument()
	})

	it("shows the wrap-up draft once the side thread answers; Send to main sends the note and closes it", async () => {
		showBeside("main", "side")
		mocks.state.sideThreadViews = [
			{
				id: "side",
				phase: "completed",
				messages: [
					{ ts: 1, type: "say", say: "user_feedback", text: WRAP_UP_PROMPT },
					{ ts: 2, type: "say", say: "text", text: "Keep 500ms. The flake is the fake clock." },
				],
			},
		]
		const { rerender } = renderPanel()
		await act(async () => {
			fireEvent.click(screen.getByTestId("wrap-up-button"))
		})
		rerender(
			<ThreadPanelHost data={{ ...data }}>
				<div>chat</div>
			</ThreadPanelHost>,
		)
		expect(screen.getByText("Send this to main?")).toBeInTheDocument()
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Send to main" }))
		})
		expect(mocks.rpc.sendSideThreadNote).toHaveBeenCalledWith({
			threadId: "side",
			text: "Keep 500ms. The flake is the fake clock.",
		})
		expect(mocks.rpc.updateSideThread).toHaveBeenCalledWith(expect.objectContaining({ threadId: "side", closed: true }))
		expect(getSideThreadSlots().beside).toEqual({})
	})
})

describe("side question card", () => {
	beforeEach(() => {
		resetSideThreadSlots()
		for (const fn of Object.values(mocks.rpc)) fn.mockClear()
		mocks.state = {
			currentTaskItem: main,
			taskHistory: [main, item("q", { parentTaskId: "main", task: "Is 500ms too short?", sideKind: "btw" })],
			sideThreadViews: [
				{
					id: "q",
					phase: "completed",
					messages: [
						{ ts: 1, type: "say", say: "user_feedback", text: "Is 500ms too short?" },
						{ ts: 2, type: "say", say: "text", text: "No, it fits." },
					],
				},
			],
		}
		showQuestion("main", "q")
	})

	it("answers above the composer and sends the answer to Main on request", async () => {
		render(<SideQuestionCard />)
		expect(screen.getByText("No, it fits.")).toBeInTheDocument()
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: /Send to main/ }))
		})
		expect(mocks.rpc.sendSideThreadNote).toHaveBeenCalledWith({ threadId: "q", text: "No, it fits." })
		expect(mocks.rpc.updateSideThread).toHaveBeenCalledWith(expect.objectContaining({ threadId: "q", closed: true }))
		expect(getSideThreadSlots().question).toEqual({})
	})

	it("keeps it as a side thread, or closes with Esc", async () => {
		const { unmount } = render(<SideQuestionCard />)
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: /Keep as side thread/ }))
		})
		expect(mocks.rpc.updateSideThread).toHaveBeenCalledWith(expect.objectContaining({ threadId: "q", kind: "side" }))
		// No room beside Main in this test: it opens as its own view.
		expect(mocks.rpc.showTaskWithId).toHaveBeenCalledWith(expect.objectContaining({ value: "q" }))
		unmount()

		showQuestion("main", "q")
		render(<SideQuestionCard />)
		await act(async () => {
			fireEvent.keyDown(screen.getByTestId("side-question-card"), { key: "Escape" })
		})
		expect(mocks.rpc.updateSideThread).toHaveBeenLastCalledWith(expect.objectContaining({ threadId: "q", closed: true }))
	})
})
