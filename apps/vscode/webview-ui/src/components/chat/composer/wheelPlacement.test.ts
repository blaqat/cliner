import { describe, expect, it } from "vitest"
import { placeWheel, WHEEL_ROW_HEIGHT, wheelRowCount } from "./wheelPlacement"

const viewport = { width: 400, height: 800 }
const popup = { width: 240, above: 5, below: 30 }

describe("wheelRowCount", () => {
	it.each([
		[1000, 5],
		[120, 5],
		[119, 3],
		[96, 3],
		[72, 3],
		[71, 1],
		[10, 1],
	])("fits %ipx with %i rows (odd, never more than five)", (available, rows) => {
		expect(wheelRowCount(available)).toBe(rows)
	})
})

describe("placeWheel", () => {
	it("puts the center row's text exactly over the chip text", () => {
		const anchor = { left: 100, top: 400, height: 16 }
		const placed = placeWheel({ anchor, viewport, popup, rowInset: 9 })
		expect(placed.rows).toBe(5)
		expect(placed.aligned).toBe(true)
		// Center row: below the part above the wheel and two rows; its middle is the anchor's middle.
		const centerMiddle = placed.top + popup.above + 2 * WHEEL_ROW_HEIGHT + WHEEL_ROW_HEIGHT / 2
		expect(centerMiddle).toBe(anchor.top + anchor.height / 2)
		expect(placed.left + 9).toBe(anchor.left)
	})

	it("shifts up near the bottom edge and stays fully on screen", () => {
		const anchor = { left: 100, top: 780, height: 16 }
		const placed = placeWheel({ anchor, viewport, popup, rowInset: 9 })
		const height = popup.above + placed.rows * WHEEL_ROW_HEIGHT + popup.below
		expect(placed.top + height).toBeLessThanOrEqual(viewport.height - 4)
		expect(placed.rows).toBe(5)
		expect(placed.aligned).toBe(false)
	})

	it("never goes above the top edge", () => {
		const placed = placeWheel({ anchor: { left: 100, top: 2, height: 16 }, viewport, popup, rowInset: 9 })
		expect(placed.top).toBe(4)
	})

	it("shows fewer rows in a short window rather than clipping", () => {
		const short = { width: 400, height: 140 }
		const placed = placeWheel({ anchor: { left: 100, top: 100, height: 16 }, viewport: short, popup, rowInset: 9 })
		expect(placed.rows).toBe(3)
		const height = popup.above + placed.rows * WHEEL_ROW_HEIGHT + popup.below
		expect(placed.top).toBeGreaterThanOrEqual(4)
		expect(placed.top + height).toBeLessThanOrEqual(short.height - 4)
	})

	it("keeps the wheel column under the chip text when the popup moves left to stay on screen", () => {
		const anchor = { left: 250, top: 400, height: 16 }
		const placed = placeWheel({ anchor, viewport, popup, rowInset: 9 })
		expect(placed.left + popup.width).toBeLessThanOrEqual(viewport.width - 4)
		expect(placed.left + placed.columnOffset + 9).toBe(anchor.left)
		expect(placed.aligned).toBe(true)
	})

	it("opens above the anchor like a menu without a wheel", () => {
		const anchor = { left: 100, top: 500, height: 16 }
		const placed = placeWheel({ anchor, viewport, popup: { width: 240, above: 200, below: 0 }, rowInset: 9, noWheel: true })
		expect(placed.rows).toBe(0)
		expect(placed.top + 200).toBeLessThanOrEqual(anchor.top)
		expect(placed.aligned).toBe(false)
	})
})
