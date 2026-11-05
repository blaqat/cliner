import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import AttachButton from "./AttachButton"

describe("AttachButton", () => {
	it("opens the files & images picker", () => {
		const onAddFiles = vi.fn()
		render(<AttachButton disabled={false} max={20} onAddFiles={onAddFiles} />)
		const button = screen.getByTestId("attach-button")
		expect(button).toHaveAccessibleName("Attach files & images")
		fireEvent.click(button)
		expect(onAddFiles).toHaveBeenCalledOnce()
	})

	it("when the message is full, stays focusable and says why instead of opening", () => {
		const onAddFiles = vi.fn()
		render(<AttachButton disabled max={20} onAddFiles={onAddFiles} />)
		const button = screen.getByTestId("attach-button")
		expect(button).toHaveAttribute("aria-disabled", "true")
		expect(button).not.toBeDisabled()
		expect(button).toHaveAccessibleName(/up to 20 files and images\. Remove one to add another/)
		expect(button.title).toBe(button.getAttribute("aria-label"))
		fireEvent.click(button)
		expect(onAddFiles).not.toHaveBeenCalled()
	})
})
