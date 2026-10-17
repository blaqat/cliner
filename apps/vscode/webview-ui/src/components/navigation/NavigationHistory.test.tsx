import { act, fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { BackButton } from "./BackButton"
import { NavigationHistoryProvider, useNavigationHistory } from "./NavigationHistoryContext"
import { locationKey } from "./navHistory"

const openTask = vi.hoisted(() => vi.fn(() => Promise.resolve()))
vi.mock("@/components/inbox/sessionActions", () => ({ openTask }))

const actions = {
	navigateToSettings: vi.fn(),
	navigateToHistory: vi.fn(),
	navigateToAccount: vi.fn(),
	navigateToWorktrees: vi.fn(),
	navigateToMarketplace: vi.fn(),
	navigateToTaskGroup: vi.fn(),
	navigateToChat: vi.fn(),
	setShowMcp: vi.fn(),
}
const baseState = () => ({
	...actions,
	showSettings: false,
	settingsNavigationRequest: undefined,
	showHistory: false,
	showMarketplace: false,
	showMcp: false,
	showAccount: false,
	showWorktrees: false,
	taskGroupView: null as { id: string; page: "home" | "notebook" } | null,
	currentTaskItem: undefined as { id: string } | undefined,
	taskHistory: [
		{ id: "a", ts: 1, task: "Thread A", taskGroupId: "t" },
		{ id: "b", ts: 2, task: "Thread B" },
	],
	taskGroups: [{ id: "t", title: "Task T", tags: [], createdAt: 0, updatedAt: 0, noteCount: 0 }],
})
let state = baseState()
vi.mock("@/context/ExtensionStateContext", () => ({ useExtensionState: () => state }))

const chat = { closeThread: vi.fn(), openSearch: vi.fn(), closeSearch: vi.fn() }

const Probe = ({ crumbIds }: { crumbIds: string[] }) => {
	const nav = useNavigationHistory()
	return (
		<div>
			<span data-testid="entries">{nav?.entries.map(locationKey).join(" > ")}</span>
			<button onClick={() => nav?.registerChat(chat)} type="button">
				register
			</button>
			<button onClick={() => nav?.reportSearch(true, "export")} type="button">
				open-search
			</button>
			<BackButton crumbIds={crumbIds} />
		</div>
	)
}

function setup() {
	state = baseState()
	const view = render(
		<NavigationHistoryProvider>
			<Probe crumbIds={[]} />
		</NavigationHistoryProvider>,
	)
	fireEvent.click(screen.getByText("register"))
	const go = (patch: Partial<ReturnType<typeof baseState>>, crumbIds: string[] = []) => {
		state = { ...state, ...patch }
		act(() =>
			view.rerender(
				<NavigationHistoryProvider>
					<Probe crumbIds={crumbIds} />
				</NavigationHistoryProvider>,
			),
		)
	}
	return { go }
}

const entries = () => screen.getByTestId("entries").textContent

describe("navigation history", () => {
	beforeEach(() => {
		vi.stubGlobal(
			"ResizeObserver",
			class {
				observe() {}
				unobserve() {}
				disconnect() {}
			},
		)
		for (const fn of [...Object.values(actions), ...Object.values(chat), openTask]) fn.mockClear()
	})

	it("records where you go and has no Back on the first page", () => {
		const { go } = setup()
		expect(screen.queryByTestId("crumb-back")).toBeNull()
		go({ taskGroupView: { id: "t", page: "home" } })
		go({ taskGroupView: null, currentTaskItem: { id: "a" } })
		expect(entries()).toBe("home > task:t:home > thread:a")
	})

	it("Back restores the previous place and ignores screens on the way", () => {
		const { go } = setup()
		go({ currentTaskItem: { id: "a" } })
		go({ showSettings: true })
		go({ showSettings: false })
		// Done returns to A: A → settings → A collapses
		expect(entries()).toBe("home > thread:a")
		go({ currentTaskItem: { id: "b" } })
		expect(entries()).toBe("home > thread:a > thread:b")

		fireEvent.click(screen.getByTestId("crumb-back"))
		expect(actions.navigateToChat).toHaveBeenCalled()
		expect(openTask).toHaveBeenCalledWith("a")
		expect(entries()).toBe("home > thread:a")
		// home flashes before the thread arrives; it isn't a visit
		go({ currentTaskItem: undefined })
		go({ currentTaskItem: { id: "a" } })
		expect(entries()).toBe("home > thread:a")
	})

	it("returns to search with its last query", () => {
		const { go } = setup()
		fireEvent.click(screen.getByText("open-search"))
		go({ currentTaskItem: { id: "a" } })
		expect(entries()).toBe("home > search > thread:a")
		fireEvent.click(screen.getByTestId("crumb-back"))
		expect(chat.closeThread).toHaveBeenCalled()
		expect(chat.openSearch).toHaveBeenCalledWith("export")
	})

	it("names Back only when the target is neither Home nor a breadcrumb", () => {
		const { go } = setup()
		go({ taskGroupView: { id: "t", page: "home" } }, ["home", "task:t"])
		// Back is Home
		expect(screen.getByTestId("crumb-back")).toBeInTheDocument()
		expect(screen.queryByTestId("crumb-back-label")).toBeNull()

		go({ taskGroupView: null, currentTaskItem: { id: "a" } }, ["home", "task:t", "a"])
		// came from a task page that is in the thread's crumbs: arrow only
		expect(entries()).toBe("home > task:t:home > thread:a")
		expect(screen.queryByTestId("crumb-back-label")).toBeNull()
		expect(screen.queryByTestId("crumb-back-bar")).toBeNull()

		go({ currentTaskItem: { id: "b" } }, ["home", "b"])
		// came from thread A, which isn't in B's crumbs
		expect(screen.getByTestId("crumb-back-label")).toHaveTextContent("Thread A")
		expect(screen.getByTestId("crumb-back-bar")).toBeInTheDocument()
	})

	it("right-click lists history; picking an entry jumps there", () => {
		const { go } = setup()
		go({ currentTaskItem: { id: "a" } })
		go({ currentTaskItem: { id: "b" } })
		go({ currentTaskItem: undefined, showSettings: true })
		fireEvent.contextMenu(screen.getByTestId("crumb-back"))
		const items = screen.getAllByTestId("back-history-item").map((item) => item.textContent)
		expect(items).toEqual(["Thread B", "Thread ATask T", "Home"])
		fireEvent.click(screen.getAllByTestId("back-history-item")[1])
		expect(entries()).toBe("home > thread:a")
		expect(openTask).toHaveBeenCalledWith("a")
	})

	it("long-press opens the list without going back", () => {
		vi.useFakeTimers()
		try {
			const { go } = setup()
			go({ currentTaskItem: { id: "a" } })
			const back = screen.getByTestId("crumb-back")
			fireEvent.pointerDown(back, { button: 0 })
			act(() => vi.advanceTimersByTime(500))
			fireEvent.pointerUp(back)
			fireEvent.click(back)
			expect(screen.getByTestId("back-history-menu")).toBeInTheDocument()
			expect(entries()).toBe("home > thread:a")
		} finally {
			vi.useRealTimers()
		}
	})
})
