import { describe, expect, it } from "vitest"
import { type ComposerRowContent, composerRowLayout, composerRowMinWidth, FULL_COMPOSER_ROW } from "./composerRowLayout"

const WIDEST: ComposerRowContent = { hasUsage: true, hasCost: true, hasCompactNudge: true, hasEffort: true }

describe("composerRowLayout", () => {
	it("shows the full row until the width is measured", () => {
		expect(composerRowLayout(undefined, WIDEST)).toBe(FULL_COMPOSER_ROW)
		expect(composerRowLayout(0, WIDEST)).toBe(FULL_COMPOSER_ROW)
	})

	it("shows everything when it fits", () => {
		expect(composerRowLayout(600, WIDEST)).toEqual(FULL_COMPOSER_ROW)
	})

	it("collapses in order as the row narrows: cost, then the Compact pill, then pickers, then the config picker", () => {
		const seen: string[] = []
		for (let width = 600; width >= 200; width--) {
			const layout = composerRowLayout(width, WIDEST)
			const step = [
				!layout.showCost && "cost",
				!layout.inlineCompactNudge && "nudge",
				layout.collapsePickers && "pickers",
				layout.collapseConfig && "config",
			]
				.filter(Boolean)
				.join("+")
			if (seen[seen.length - 1] !== step) {
				seen.push(step)
			}
		}
		expect(seen).toEqual(["", "cost", "cost+nudge", "cost+nudge+pickers", "cost+nudge+pickers+config"])
	})

	it("collapses only as far as each width needs", () => {
		for (const width of [250, 280, 320, 360, 400, 480]) {
			const layout = composerRowLayout(width, WIDEST)
			expect(composerRowMinWidth(WIDEST, layout), `width ${width}`).toBeLessThanOrEqual(width)
		}
	})

	it("fits the sidebar widths the review called out", () => {
		expect(composerRowLayout(320, WIDEST)).toMatchObject({ showCost: false, collapsePickers: true, collapseConfig: false })
		expect(composerRowLayout(280, WIDEST)).toMatchObject({ collapsePickers: true, collapseConfig: true })
		expect(composerRowLayout(250, WIDEST)).toMatchObject({ collapsePickers: true, collapseConfig: true })
	})

	it("keeps the cost longer when there's no Compact pill or effort picker to make room for", () => {
		const width = composerRowMinWidth(WIDEST, FULL_COMPOSER_ROW) - 1
		expect(composerRowLayout(width, WIDEST).showCost).toBe(false)
		expect(composerRowLayout(width, { ...WIDEST, hasCompactNudge: false }).showCost).toBe(true)
		expect(composerRowLayout(width, { ...WIDEST, hasEffort: false }).showCost).toBe(true)
	})

	it("needs less room on the home composer, which has no meter", () => {
		const home = { hasUsage: false, hasCost: false, hasCompactNudge: false, hasEffort: true }
		expect(composerRowLayout(320, home).collapsePickers).toBe(false)
	})

	it("falls back to the most collapsed row when nothing fits", () => {
		expect(composerRowLayout(120, WIDEST)).toEqual({
			showCost: false,
			inlineCompactNudge: false,
			collapsePickers: true,
			collapseConfig: true,
		})
	})
})
