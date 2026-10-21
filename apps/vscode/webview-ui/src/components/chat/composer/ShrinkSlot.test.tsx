import { render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ShrinkSlot } from "./ShrinkSlot"

/** jsdom has no layout: the hidden max-content copy reports `fullWidth`. */
function stubFullWidth(fullWidth: number) {
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
		const width = this.style.visibility === "hidden" ? fullWidth : 0
		return { width, height: 0, x: 0, y: 0, top: 0, left: 0, right: width, bottom: 0, toJSON: () => ({}) } as DOMRect
	})
}

const renderSlot = (floor: number) =>
	render(
		<div>
			<ShrinkSlot floor={floor}>
				<button data-testid="pill" id="pill-id" type="button">
					<span className="truncate">Med</span>
				</button>
			</ShrinkSlot>
		</div>,
	)

describe("ShrinkSlot", () => {
	afterEach(() => vi.restoreAllMocks())

	it("reserves only the pill's full width when it is narrower than the floor", () => {
		stubFullWidth(34)
		renderSlot(60)
		expect(screen.getByTestId("pill").parentElement).toHaveStyle({ minWidth: "34px" })
	})

	it("keeps the floor for a pill wider than it, and leaves no measuring copy behind", () => {
		stubFullWidth(140)
		const { container } = renderSlot(72)
		expect(screen.getByTestId("pill").parentElement).toHaveStyle({ minWidth: "72px" })
		expect(container.querySelectorAll("button")).toHaveLength(1)
		expect(container.querySelectorAll("#pill-id")).toHaveLength(1)
	})
})
