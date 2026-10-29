import type { HistoryItem } from "@shared/HistoryItem"
import { act, fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { useOneView } from "./OneViewContext"
import { OneViewLayout } from "./OneViewLayout"

const mocks = vi.hoisted(() => ({ state: {} as Record<string, unknown>, width: 900 }))

vi.mock("@/context/ExtensionStateContext", () => ({ useExtensionState: () => mocks.state }))
vi.mock("@/services/grpc-client", () => ({
	TaskServiceClient: { toggleTaskSettled: vi.fn(), toggleTaskStashed: vi.fn() },
	TaskGroupServiceClient: { searchHistory: vi.fn(async () => ({ results: [] })), openNote: vi.fn() },
}))

const NOW = Date.UTC(2026, 9, 29, 12)
const item = (id: string, extra: Partial<HistoryItem> = {}): HistoryItem => ({
	id,
	ts: NOW - 60_000,
	task: `task ${id}`,
	tokensIn: 0,
	tokensOut: 0,
	totalCost: 0,
	...extra,
})

/** Stands in for a thread header: shows the list toggle the layout lends it. */
const Header = () => <div data-testid="header">{useOneView().listToggle}</div>

const renderLayout = (props: Partial<Parameters<typeof OneViewLayout>[0]> = {}) => {
	const handlers = { onOpenThread: vi.fn(), onOpenTaskGroup: vi.fn(), onNewChat: vi.fn() }
	const utils = render(
		<OneViewLayout hidden={false} now={NOW} {...handlers} {...props}>
			<Header />
		</OneViewLayout>,
	)
	return { ...handlers, ...utils }
}

describe("OneViewLayout", () => {
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
		mocks.width = 900
		mocks.state = {
			taskHistory: [item("a", { title: "Alpha" }), item("b", { title: "Beta", ts: NOW - 120_000 })],
			sessionStatuses: { a: "running" },
			taskGroups: [],
		}
	})

	it("puts the list beside the chat when wide, with a header toggle that hides it (remembered)", () => {
		const { unmount } = renderLayout()
		expect(screen.getByTestId("one-view")).toHaveAttribute("data-placement", "left")
		expect(screen.getByTestId("one-view-side")).toHaveAttribute("data-dock", "left")
		const toggle = screen.getByRole("button", { name: "Hide the list" })
		fireEvent.click(toggle)
		expect(screen.queryByTestId("one-view-side")).toBeNull()
		expect(localStorage.getItem("oneView.listHidden")).toBe("1")
		unmount()
		renderLayout()
		expect(screen.queryByTestId("one-view-side")).toBeNull()
		fireEvent.click(screen.getByRole("button", { name: "Show the list" }))
		expect(screen.getByTestId("one-view-side")).toBeInTheDocument()
	})

	it("is a strip of thread chips when narrow, without a header toggle or dock grip", () => {
		mocks.width = 380
		const { onOpenThread } = renderLayout({ currentThreadId: "b" })
		expect(screen.getByTestId("one-view")).toHaveAttribute("data-placement", "top")
		expect(screen.queryByTestId("one-view-side")).toBeNull()
		expect(screen.queryByTestId("one-view-list-toggle")).toBeNull()
		expect(screen.queryByTestId("one-view-grip")).toBeNull()
		const chips = screen.getAllByTestId("one-view-strip-chip")
		expect(chips.map((chip) => chip.textContent)).toEqual(["Alpha", "Beta"])
		expect(chips[1]).toHaveAttribute("aria-current", "true")
		fireEvent.click(chips[0])
		expect(onOpenThread).toHaveBeenCalledWith("a")
	})

	it("drops the full list under the strip from ☰ and closes it on Esc or a click outside", () => {
		mocks.width = 380
		const { onOpenThread } = renderLayout()
		fireEvent.click(screen.getByTestId("one-view-strip-menu"))
		const dropdown = screen.getByTestId("one-view-dropdown")
		expect(dropdown).toContainElement(screen.getByTestId("one-view-search"))
		fireEvent.keyDown(screen.getByTestId("one-view-search"), { key: "Escape" })
		expect(screen.queryByTestId("one-view-dropdown")).toBeNull()

		fireEvent.click(screen.getByTestId("one-view-strip-search"))
		expect(document.activeElement).toBe(screen.getByTestId("one-view-search"))
		fireEvent.pointerDown(screen.getByTestId("header"))
		expect(screen.queryByTestId("one-view-dropdown")).toBeNull()

		fireEvent.click(screen.getByTestId("one-view-strip-menu"))
		fireEvent.click(screen.getAllByTestId("one-view-row")[1])
		expect(onOpenThread).toHaveBeenCalledWith("b")
		expect(screen.queryByTestId("one-view-dropdown")).toBeNull()
	})

	it("docks from the grip's menu and remembers the dock", () => {
		const { unmount } = renderLayout()
		fireEvent.click(screen.getByTestId("one-view-grip"))
		fireEvent.click(screen.getByRole("menuitemradio", { name: "Dock right" }))
		expect(screen.getByTestId("one-view-side")).toHaveAttribute("data-dock", "right")
		expect(localStorage.getItem("oneView.dock")).toBe("right")
		unmount()
		renderLayout()
		expect(screen.getByTestId("one-view-side")).toHaveAttribute("data-dock", "right")
		// The main region stays first and the list follows it.
		const shell = screen.getByTestId("one-view")
		expect(shell.firstElementChild).toBe(screen.getByTestId("one-view-main"))
	})

	it("docks where the grip is dropped, showing the target while dragging", () => {
		renderLayout()
		const shell = screen.getByTestId("one-view")
		shell.getBoundingClientRect = () => ({
			left: 0,
			top: 0,
			width: 900,
			height: 600,
			right: 900,
			bottom: 600,
			x: 0,
			y: 0,
			toJSON() {},
		})
		const grip = screen.getByTestId("one-view-grip")
		fireEvent.pointerDown(grip, { button: 0, clientX: 10, clientY: 300 })
		act(() => {
			window.dispatchEvent(new MouseEvent("pointermove", { clientX: 450, clientY: 40 }))
		})
		expect(screen.getByTestId("one-view-dock-overlay")).toHaveAttribute("data-zone", "top")
		act(() => {
			window.dispatchEvent(new MouseEvent("pointerup", { clientX: 450, clientY: 40 }))
		})
		expect(screen.queryByTestId("one-view-dock-overlay")).toBeNull()
		expect(screen.getByTestId("one-view")).toHaveAttribute("data-placement", "top")
		// Wide and docked on top: the strip keeps the grip so the list can go back to a side.
		expect(screen.getByTestId("one-view-grip")).toBeInTheDocument()
		expect(localStorage.getItem("oneView.dock")).toBe("top")
	})

	it("resizes the side list from its edge with the keyboard, within bounds", () => {
		renderLayout()
		const handle = screen.getByRole("separator", { name: "Resize the list" })
		expect(handle).toHaveAttribute("aria-valuenow", "260")
		fireEvent.keyDown(handle, { key: "ArrowRight" })
		expect(handle).toHaveAttribute("aria-valuenow", "276")
		expect(localStorage.getItem("oneView.listWidth")).toBe("276")
	})

	it("covers nothing while a full-page view is open", () => {
		renderLayout({ hidden: true })
		expect(screen.getByTestId("one-view")).toHaveStyle({ display: "none" })
	})
})
