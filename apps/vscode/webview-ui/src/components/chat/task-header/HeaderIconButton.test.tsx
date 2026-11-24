import { act, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { HeaderIconButton } from "./HeaderIconButton"

// Radix positions the tooltip with a ResizeObserver, which jsdom lacks.
globalThis.ResizeObserver ??= class {
	observe() {}
	unobserve() {}
	disconnect() {}
} as unknown as typeof ResizeObserver

describe("HeaderIconButton", () => {
	afterEach(() => vi.useRealTimers())

	it("shows its tooltip on focus", async () => {
		render(<HeaderIconButton icon="ellipsis" label="Task actions" />)
		fireEvent.focus(screen.getByRole("button", { name: "Task actions" }))
		expect(await screen.findByRole("tooltip")).toHaveTextContent("Task actions")
	})

	it("keeps the tooltip hidden while its menu is open and when the closing menu hands focus back", async () => {
		vi.useFakeTimers({ toFake: ["Date"] })
		const { rerender } = render(<HeaderIconButton aria-expanded icon="ellipsis" label="Task actions" />)
		const button = screen.getByRole("button", { name: "Task actions" })
		fireEvent.focus(button)
		expect(screen.queryByRole("tooltip")).not.toBeInTheDocument()
		// The menu closes (say, Delete task… opened a confirm) and returns focus to the button.
		rerender(<HeaderIconButton aria-expanded={false} icon="ellipsis" label="Task actions" />)
		fireEvent.blur(button)
		fireEvent.focus(button)
		expect(screen.queryByRole("tooltip")).not.toBeInTheDocument()
		// Later, focusing it again shows the tooltip as usual.
		fireEvent.blur(button)
		act(() => vi.setSystemTime(Date.now() + 1000))
		fireEvent.focus(button)
		expect(await screen.findByRole("tooltip")).toHaveTextContent("Task actions")
	})
})
