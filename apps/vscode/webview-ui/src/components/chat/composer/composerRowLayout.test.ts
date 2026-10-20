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
const MOST_COLLAPSED: ComposerRowLayout = {
	inlinePanelButtons: false,
	showCost: false,
	inlineCompactNudge: false,
	tightPills: true,
}
const BARE_METER = { inlinePanelButtons: true, showCost: false, inlineCompactNudge: false, tightPills: false }
const TIGHT = { ...BARE_METER, tightPills: true }

describe("composerRowLayout", () => {
	it("shows the full row until the width is measured", () => {
		expect(composerRowLayout(undefined, WIDEST)).toBe(FULL_COMPOSER_ROW)
		expect(composerRowLayout(0, WIDEST)).toBe(FULL_COMPOSER_ROW)
	})

	it("shows everything, MCP and rules buttons included, when it fits", () => {
		expect(FULL_COMPOSER_ROW).toEqual({
			inlinePanelButtons: true,
			showCost: true,
			inlineCompactNudge: true,
			tightPills: false,
		})
		expect(composerRowLayout(600, WIDEST)).toEqual(FULL_COMPOSER_ROW)
	})

	it("gives way in order once the pickers are truncated: cost, Compact, tight pills, and the panel buttons last", () => {
		const seen: string[] = []
		for (let width = 600; width >= 150; width--) {
			const layout = composerRowLayout(width, WIDEST)
			const step = [
				!layout.showCost && "cost",
				!layout.inlineCompactNudge && "nudge",
				layout.tightPills && "tight",
				!layout.inlinePanelButtons && "panels",
			]
				.filter(Boolean)
				.join("+")
			if (seen[seen.length - 1] !== step) {
				seen.push(step)
			}
		}
		expect(seen).toEqual(["", "cost", "cost+nudge", "cost+nudge+tight", "cost+nudge+tight+panels"])
	})

	it("collapses only as far as each width needs", () => {
		for (const width of [270, 300, 320, 330, 360, 400, 440, 480, 520]) {
			const layout = composerRowLayout(width, WIDEST)
			expect(composerRowMinWidth(WIDEST, layout), `width ${width}`).toBeLessThanOrEqual(width)
		}
	})

	it("counts the MCP and rules buttons, each with its gap, only while they are inline", () => {
		const w = COMPOSER_ROW_WIDTHS
		expect(composerRowMinWidth(WIDEST, TIGHT) - composerRowMinWidth(WIDEST, MOST_COLLAPSED)).toBe(
			2 * (w.panelButton + w.groupGap),
		)
	})

	it("tight pills: icon-only where pill and lower picker minimums", () => {
		const w = COMPOSER_ROW_WIDTHS
		expect(composerRowMinWidth(WIDEST, BARE_METER) - composerRowMinWidth(WIDEST, TIGHT)).toBe(
			w.whereMin - w.whereTight + w.configMin - w.configTight + w.effortMin - w.effortTight,
		)
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
		expect(composerRowLayout(full - 1, WIDEST).tightPills).toBe(false)
	})

	// Thresholds with the widest meter (cost and Compact pill) and an effort picker:
	// full ≥488, no cost ≥445, no Compact ≥369, tight pills ≥317, panel buttons folded below 317.
	it.each([
		[600, FULL_COMPOSER_ROW],
		[488, FULL_COMPOSER_ROW],
		[487, { ...FULL_COMPOSER_ROW, showCost: false }],
		[445, { ...FULL_COMPOSER_ROW, showCost: false }],
		[444, BARE_METER],
		[369, BARE_METER],
		[368, TIGHT],
		[320, TIGHT],
		[317, TIGHT],
		[316, MOST_COLLAPSED],
		[280, MOST_COLLAPSED],
	])("at %ipx with the widest meter", (width, expected) => {
		expect(composerRowLayout(width, WIDEST)).toEqual(expected)
	})

	it("keeps the MCP and rules buttons in a 320px sidebar during a chat, with or without effort", () => {
		expect(composerRowLayout(320, WIDEST).inlinePanelButtons).toBe(true)
		const noEffort = { ...WIDEST, hasEffort: false }
		// Without an effort picker the pills don't even need to go tight.
		expect(composerRowLayout(321, noEffort)).toEqual(BARE_METER)
		expect(composerRowLayout(320, noEffort)).toEqual(TIGHT)
		expect(composerRowLayout(285, noEffort)).toEqual(TIGHT)
		expect(composerRowLayout(284, noEffort)).toEqual(MOST_COLLAPSED)
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

	it("keeps the panel buttons on the home composer, which has no meter, down to 290px", () => {
		const home = { hasUsage: false, hasCost: false, hasCompactNudge: false, hasEffort: true }
		expect(composerRowMinWidth(home, FULL_COMPOSER_ROW)).toBeLessThan(composerRowMinWidth(WIDEST, FULL_COMPOSER_ROW))
		expect(composerRowLayout(342, home)).toEqual(FULL_COMPOSER_ROW)
		expect(composerRowLayout(341, home).tightPills).toBe(true)
		expect(composerRowLayout(290, home).inlinePanelButtons).toBe(true)
		expect(composerRowLayout(289, home).inlinePanelButtons).toBe(false)
	})

	it("falls back to the most collapsed row when nothing fits", () => {
		expect(composerRowLayout(120, WIDEST)).toEqual(MOST_COLLAPSED)
	})
})
