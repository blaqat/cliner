import { fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { WarningText } from "./WarningText"

describe("WarningText", () => {
	afterEach(() => vi.restoreAllMocks())

	it("sets names off as code and keeps paragraphs apart", () => {
		const { container } = render(
			<WarningText
				text={
					"Git work only this worktree has: a stash (2ebe885) in `nested`.\n\nThere may be changes never copied here."
				}
			/>,
		)
		expect(container.querySelectorAll("p")).toHaveLength(2)
		expect(screen.getByText("nested").tagName).toBe("CODE")
		// Short text needs no toggle.
		expect(screen.queryByRole("button")).not.toBeInTheDocument()
	})

	it("puts the rest of a long warning behind Show details", () => {
		vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(400)
		vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(80)
		render(<WarningText text="A long warning about a worktree." />)
		const toggle = screen.getByRole("button", { name: "Show details" })
		expect(toggle).toHaveAttribute("aria-expanded", "false")
		fireEvent.click(toggle)
		expect(screen.getByRole("button", { name: "Show less" })).toHaveAttribute("aria-expanded", "true")
	})
})
