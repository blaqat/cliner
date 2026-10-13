import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { HomeSearchBar } from "./HomeSearchBar"

vi.mock("@/context/ExtensionStateContext", () => ({ useExtensionState: () => ({}) }))
vi.mock("@/services/grpc-client", () => ({ TaskGroupServiceClient: {} }))
vi.mock("@/utils/platformUtils", () => ({ getCurrentPlatform: () => "mac" }))

describe("HomeSearchBar", () => {
	beforeEach(() => {
		vi.stubGlobal(
			"ResizeObserver",
			class ResizeObserver {
				observe() {}
				unobserve() {}
				disconnect() {}
			},
		)
	})

	it("opens search on click and on typing, with the query", () => {
		const onOpenSearch = vi.fn()
		render(<HomeSearchBar onOpenSearch={onOpenSearch} />)
		const input = screen.getByTestId("home-search-input")
		fireEvent.click(input)
		expect(onOpenSearch).toHaveBeenLastCalledWith("")
		fireEvent.change(input, { target: { value: "PROJ-482" } })
		expect(onOpenSearch).toHaveBeenLastCalledWith("PROJ-482")
	})

	it("focuses the field on ⌘K", () => {
		render(<HomeSearchBar onOpenSearch={vi.fn()} />)
		expect(screen.getByText("⌘K")).toBeInTheDocument()
		fireEvent.keyDown(window, { key: "k", metaKey: true })
		expect(screen.getByTestId("home-search-input")).toHaveFocus()
	})

	it("＋ Task opens the new-task sheet with the home copy", () => {
		render(<HomeSearchBar onOpenSearch={vi.fn()} />)
		fireEvent.click(screen.getByTestId("home-new-task-button"))
		expect(screen.getByTestId("new-task-sheet")).toHaveTextContent("Creates an empty task.")
	})
})
