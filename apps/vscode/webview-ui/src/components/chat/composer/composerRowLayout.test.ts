import { describe, expect, it } from "vitest"
import {
	COMPOSER_ROW_WIDTHS,
	type ComposerRowContent,
	type ComposerRowLayout,
	composerRowLayout,
	composerRowMinWidth,
	FULL_COMPOSER_ROW,
} from "./composerRowLayout"

const WIDEST: ComposerRowContent = { hasUsage: true, hasCost: true, hasCompactNudge: true, hasEffort: true }
const MOST_COLLAPSED: ComposerRowLayout = { inlinePanelButtons: false, showCost: false, inlineCompactNudge: false }

describe("composerRowLayout", () => {
	it("shows the full row until the width is measured", () => {
		expect(composerRowLayout(undefined, WIDEST)).toBe(FULL_COMPOSER_ROW)
		expect(composerRowLayout(0, WIDEST)).toBe(FULL_COMPOSER_ROW)
	})

	it("shows everything, MCP and rules buttons included, when it fits", () => {
		expect(FULL_COMPOSER_ROW).toEqual({ inlinePanelButtons: true, showCost: true, inlineCompactNudge: true })
		expect(composerRowLayout(600, WIDEST)).toEqual(FULL_COMPOSER_ROW)
	})

	it("gives way in order as the row narrows, once the pickers are truncated: cost, panel buttons, then Compact", () => {
		const seen: string[] = []
		for (let width = 600; width >= 150; width--) {
			const layout = composerRowLayout(width, WIDEST)
			const step = [
				!layout.showCost && "cost",
				!layout.inlinePanelButtons && "panels",
				!layout.inlineCompactNudge && "nudge",
			]
				.filter(Boolean)
				.join("+")
			if (seen[seen.length - 1] !== step) {
				seen.push(step)
			}
		}
		expect(seen).toEqual(["", "cost", "cost+panels", "cost+panels+nudge"])
	})

	it("collapses only as far as each width needs", () => {
		for (const width of [330, 360, 400, 440, 480, 520]) {
			const layout = composerRowLayout(width, WIDEST)
			expect(composerRowMinWidth(WIDEST, layout), `width ${width}`).toBeLessThanOrEqual(width)
		}
	})

	it("counts the MCP and rules buttons, each with its gap, only while they are inline", () => {
		const w = COMPOSER_ROW_WIDTHS
		const inline = composerRowMinWidth(WIDEST, { ...MOST_COLLAPSED, inlinePanelButtons: true })
		expect(inline - composerRowMinWidth(WIDEST, MOST_COLLAPSED)).toBe(2 * (w.panelButton + w.groupGap))
	})

	it("keeps the configuration and effort pickers readable before hiding the cost", () => {
		const w = COMPOSER_ROW_WIDTHS
		// The cost goes only once the pickers are down to a few characters each.
		const full = composerRowMinWidth(WIDEST, FULL_COMPOSER_ROW)
		expect(full).toBeGreaterThanOrEqual(
			w.plus + 2 * w.panelButton + w.whereMin + w.configMin + w.effortMin + w.approvals + w.ring + w.cost + w.modeSwitch,
		)
		expect(composerRowLayout(full, WIDEST).showCost).toBe(true)
		expect(composerRowLayout(full - 1, WIDEST).showCost).toBe(false)
		expect(composerRowLayout(full - 1, WIDEST).inlinePanelButtons).toBe(true)
	})

	it.each([
		[480, { inlinePanelButtons: true, showCost: false, inlineCompactNudge: true }],
		[440, { inlinePanelButtons: false, showCost: false, inlineCompactNudge: true }],
		[400, { inlinePanelButtons: false, showCost: false, inlineCompactNudge: true }],
		[360, MOST_COLLAPSED],
		[300, MOST_COLLAPSED],
	])("at %ipx with the widest meter", (width, expected) => {
		expect(composerRowLayout(width, WIDEST)).toEqual(expected)
	})

	it("fits a 320px sidebar with the ring and its Compact pill when the model has no effort", () => {
		const noEffort = { ...WIDEST, hasEffort: false }
		expect(composerRowLayout(360, noEffort)).toEqual({ inlinePanelButtons: false, showCost: false, inlineCompactNudge: true })
		expect(composerRowLayout(320, noEffort)).toEqual(MOST_COLLAPSED)
	})

	it("makes room for the effort picker only when the model has reasoning", () => {
		const w = COMPOSER_ROW_WIDTHS
		const noEffort = { ...WIDEST, hasEffort: false }
		expect(composerRowMinWidth(WIDEST, FULL_COMPOSER_ROW) - composerRowMinWidth(noEffort, FULL_COMPOSER_ROW)).toBe(
			w.effortMin + w.groupGap,
		)
	})

	it("keeps the cost longer when there's no Compact pill to make room for", () => {
		const width = composerRowMinWidth(WIDEST, FULL_COMPOSER_ROW) - 1
		expect(composerRowLayout(width, WIDEST).showCost).toBe(false)
		expect(composerRowLayout(width, { ...WIDEST, hasCompactNudge: false }).showCost).toBe(true)
	})

	it("keeps the panel buttons on the home composer, which has no meter, down to a narrow sidebar", () => {
		const home = { hasUsage: false, hasCost: false, hasCompactNudge: false, hasEffort: true }
		expect(composerRowMinWidth(home, FULL_COMPOSER_ROW)).toBeLessThan(composerRowMinWidth(WIDEST, FULL_COMPOSER_ROW))
		expect(composerRowLayout(360, home)).toEqual(FULL_COMPOSER_ROW)
		expect(composerRowLayout(300, home).inlinePanelButtons).toBe(false)
	})

	it("falls back to the most collapsed row when nothing fits", () => {
		expect(composerRowLayout(120, WIDEST)).toEqual(MOST_COLLAPSED)
	})
})
