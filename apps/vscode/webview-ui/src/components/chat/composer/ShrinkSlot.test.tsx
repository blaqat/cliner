import { render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ShrinkSlot } from "./ShrinkSlot"

function stubSizes(pill: number, label: { scroll: number; client: number }) {
	vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
		return this.dataset.testid === "pill" ? pill : 0
	})
	vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (this: HTMLElement) {
		return this.classList.contains("truncate") ? label.scroll : 0
	})
	vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
		return this.classList.contains("truncate") ? label.client : 0
	})
}

const renderSlot = (floor: number) =>
	render(
		<ShrinkSlot floor={floor}>
			<button data-testid="pill" type="button">
				<span className="truncate">Med</span>
			</button>
		</ShrinkSlot>,
	)

describe("ShrinkSlot", () => {
	afterEach(() => vi.restoreAllMocks())

	it("reserves only the pill's width when its label is shorter than the floor", () => {
		stubSizes(34, { scroll: 24, client: 24 })
		renderSlot(60)
		expect(screen.getByTestId("pill").parentElement).toHaveStyle({ minWidth: "34px" })
	})

	it("lets a squeezed pill shrink to the floor, counting the label it hides", () => {
		stubSizes(50, { scroll: 90, client: 40 })
		renderSlot(72)
		expect(screen.getByTestId("pill").parentElement).toHaveStyle({ minWidth: "72px" })
	})
})
