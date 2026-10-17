import { describe, expect, it } from "vitest"
import {
	COMPOSER_ROW_WIDTHS,
	type ComposerRowContent,
	composerRowLayout,
	composerRowMinWidth,
	FULL_COMPOSER_ROW,
} from "./composerRowLayout"

const WIDEST: ComposerRowContent = { hasUsage: true, hasCost: true, hasCompactNudge: true }

describe("composerRowLayout", () => {
	it("shows the full row until the width is measured", () => {
		expect(composerRowLayout(undefined, WIDEST)).toBe(FULL_COMPOSER_ROW)
		expect(composerRowLayout(0, WIDEST)).toBe(FULL_COMPOSER_ROW)
	})

	it("shows everything when it fits", () => {
		expect(composerRowLayout(600, WIDEST)).toEqual(FULL_COMPOSER_ROW)
	})

	it("hides in order as the row narrows, once the pills are truncated: cost, then the Compact pill", () => {
		const seen: string[] = []
		for (let width = 600; width >= 150; width--) {
			const layout = composerRowLayout(width, WIDEST)
			const step = [!layout.showCost && "cost", !layout.inlineCompactNudge && "nudge"].filter(Boolean).join("+")
			if (seen[seen.length - 1] !== step) {
				seen.push(step)
			}
		}
		expect(seen).toEqual(["", "cost", "cost+nudge"])
	})

	it("collapses only as far as each width needs", () => {
		for (const width of [280, 320, 360, 400, 480]) {
			const layout = composerRowLayout(width, WIDEST)
			expect(composerRowMinWidth(WIDEST, layout), `width ${width}`).toBeLessThanOrEqual(width)
		}
	})

	it("keeps the pills readable before hiding the cost", () => {
		const w = COMPOSER_ROW_WIDTHS
		// The cost goes only once the pills are down to a few characters each.
		const full = composerRowMinWidth(WIDEST, FULL_COMPOSER_ROW)
		expect(full).toBeGreaterThanOrEqual(w.plus + w.whereMin + w.modelMin + w.ring + w.cost + w.modeSwitch)
		expect(composerRowLayout(full, WIDEST).showCost).toBe(true)
		expect(composerRowLayout(full - 1, WIDEST).showCost).toBe(false)
	})

	it("fits a 320px sidebar with the ring and its Compact pill", () => {
		expect(composerRowLayout(360, WIDEST)).toEqual({ showCost: false, inlineCompactNudge: true })
		expect(composerRowLayout(320, WIDEST)).toEqual({ showCost: false, inlineCompactNudge: false })
	})

	it("keeps the cost longer when there's no Compact pill to make room for", () => {
		const width = composerRowMinWidth(WIDEST, FULL_COMPOSER_ROW) - 1
		expect(composerRowLayout(width, WIDEST).showCost).toBe(false)
		expect(composerRowLayout(width, { ...WIDEST, hasCompactNudge: false }).showCost).toBe(true)
	})

	it("needs less room on the home composer, which has no meter", () => {
		const home = { hasUsage: false, hasCost: false, hasCompactNudge: false }
		expect(composerRowMinWidth(home, FULL_COMPOSER_ROW)).toBeLessThan(composerRowMinWidth(WIDEST, FULL_COMPOSER_ROW))
		expect(composerRowLayout(250, home)).toEqual(FULL_COMPOSER_ROW)
	})

	it("falls back to the most collapsed row when nothing fits", () => {
		expect(composerRowLayout(120, WIDEST)).toEqual({ showCost: false, inlineCompactNudge: false })
	})
})
