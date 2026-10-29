import { describe, expect, it } from "vitest"
import { placeWheel, WHEEL_ROW_HEIGHT } from "./wheelPlacement"

const viewport = { width: 400, height: 800 }
const popup = { width: 200, header: 0 }
/** The middle of the pick's row. */
const pickMiddle = (top: number, above: number) => top + above * WHEEL_ROW_HEIGHT + WHEEL_ROW_HEIGHT / 2

describe("placeWheel", () => {
	it("puts the pick's text exactly over the chip text, two neighbours each side", () => {
		const anchor = { left: 100, top: 400, height: 16 }
		const placed = placeWheel({ anchor, viewport, popup, rowInset: 4 })
		expect(placed).toMatchObject({ above: 2, below: 2, aligned: true })
		expect(pickMiddle(placed.top, placed.above)).toBe(anchor.top + anchor.height / 2)
		expect(placed.left + 4).toBe(anchor.left)
	})

	it("with no room below (composer at the window bottom) shows more rows above, text still in place", () => {
		const anchor = { left: 100, top: 776, height: 16 }
		const placed = placeWheel({ anchor, viewport, popup, rowInset: 4, count: 5, index: 4 })
		expect(placed.below).toBe(0)
		expect(placed.above).toBe(4)
		expect(placed.aligned).toBe(true)
		expect(pickMiddle(placed.top, placed.above)).toBe(anchor.top + anchor.height / 2)
		expect(placed.top + (placed.above + 1) * WHEEL_ROW_HEIGHT).toBeLessThanOrEqual(viewport.height - 4)
	})

	it("without room below rolls upside down when more choices follow the pick, so they show above", () => {
		const anchor = { left: 100, top: 776, height: 16 }
		expect(placeWheel({ anchor, viewport, popup, rowInset: 4, count: 4, index: 0 })).toMatchObject({
			above: 3,
			below: 0,
			flip: true,
		})
		// More before the pick: the usual order already shows them above.
		expect(placeWheel({ anchor, viewport, popup, rowInset: 4, count: 5, index: 3 }).flip).toBe(false)
		// With room below it never flips.
		expect(
			placeWheel({ anchor: { left: 100, top: 400, height: 16 }, viewport, popup, rowInset: 4, count: 4, index: 0 }).flip,
		).toBe(false)
	})

	it("puts the icon actions left of the rolling text, keeping the text on the chip", () => {
		const anchor = { left: 200, top: 400, height: 16 }
		const placed = placeWheel({ anchor, viewport, popup, rowInset: 4, lead: 60 })
		expect(placed.left + 60 + 4).toBe(anchor.left)
		expect(placed.aligned).toBe(true)
	})

	it("one row of room below: one neighbour below, three above", () => {
		const anchor = { left: 100, top: 754, height: 16 }
		expect(placeWheel({ anchor, viewport, popup, rowInset: 4, count: 5, index: 3 })).toMatchObject({
			above: 3,
			below: 1,
			flip: false,
		})
	})

	it("leaves room for the approvals row above the wheel", () => {
		const anchor = { left: 100, top: 60, height: 16 }
		const placed = placeWheel({ anchor, viewport, popup: { width: 200, header: 26 }, rowInset: 4 })
		// The approvals row hangs above the wheel and stays on screen.
		expect(placed.top - 26).toBeGreaterThanOrEqual(4)
		expect(placed.above).toBe(1)
		expect(pickMiddle(placed.top, placed.above)).toBe(anchor.top + anchor.height / 2)
	})

	it("shifts left only as far as needed to stay on screen", () => {
		const anchor = { left: 300, top: 400, height: 16 }
		const placed = placeWheel({ anchor, viewport, popup, rowInset: 4 })
		expect(placed.left + popup.width).toBeLessThanOrEqual(viewport.width - 4)
		expect(placed.aligned).toBe(false)
	})

	it("opens just above the anchor without a wheel", () => {
		const anchor = { left: 100, top: 500, height: 16 }
		const placed = placeWheel({ anchor, viewport, popup: { width: 200, header: 30 }, rowInset: 4, noWheel: true })
		expect(placed).toMatchObject({ above: 0, below: 0, aligned: false })
		expect(placed.top + 30).toBeLessThanOrEqual(anchor.top)
	})
})
