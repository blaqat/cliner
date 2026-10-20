import { describe, expect, it } from "vitest"
import {
	COMPOSER_ROW_WIDTHS,
	type ComposerRowContent,
	type ComposerRowLayout,
	composerRowLayout,
	composerRowMinWidth,
	FULL_COMPOSER_ROW,
} from "./composerRowLayout"

const WIDEST: ComposerRowContent = { hasUsage: true, hasCost: true, hasCompactNudge: true, hasEffort: true, hasTask: false }
const WIDEST_WITH_TASK: ComposerRowContent = { ...WIDEST, hasTask: true }
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
		for (const content of [WIDEST, WIDEST_WITH_TASK]) {
			for (const width of [280, 300, 320, 330, 360, 400, 420, 440, 480, 520]) {
				const layout = composerRowLayout(width, content)
				expect(composerRowMinWidth(content, layout), `width ${width}`).toBeLessThanOrEqual(width)
			}
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
		// No task: the where pill is its icon already, so only the pickers get smaller.
		expect(composerRowMinWidth(WIDEST, BARE_METER) - composerRowMinWidth(WIDEST, TIGHT)).toBe(
			w.configMin - w.configTight + w.effortMin - w.effortTight,
		)
		expect(composerRowMinWidth(WIDEST_WITH_TASK, BARE_METER) - composerRowMinWidth(WIDEST_WITH_TASK, TIGHT)).toBe(
			w.whereNamed - w.whereIcon + w.configMin - w.configTight + w.effortMin - w.effortTight,
		)
	})

	it("needs less room for the where pill with no task, only its icon", () => {
		const w = COMPOSER_ROW_WIDTHS
		expect(composerRowMinWidth(WIDEST_WITH_TASK, FULL_COMPOSER_ROW) - composerRowMinWidth(WIDEST, FULL_COMPOSER_ROW)).toBe(
			w.whereNamed - w.whereIcon,
		)
	})

	it("keeps the configuration and effort pickers readable before hiding the cost", () => {
		const w = COMPOSER_ROW_WIDTHS
		// The cost goes only once the pickers are down to their minimums.
		const full = composerRowMinWidth(WIDEST, FULL_COMPOSER_ROW)
		expect(full).toBeGreaterThanOrEqual(
			w.plus + 2 * w.panelButton + w.whereIcon + w.configMin + w.effortMin + w.approvals + w.ring + w.cost + w.modeSwitch,
		)
		expect(composerRowLayout(full, WIDEST).showCost).toBe(true)
		expect(composerRowLayout(full - 1, WIDEST).showCost).toBe(false)
		expect(composerRowLayout(full - 1, WIDEST).tightPills).toBe(false)
	})

	// Thresholds with the widest meter (cost and Compact pill) and an effort picker:
	// full ≥502, no cost ≥459, no Compact ≥383, tight pills ≥319, panel buttons folded below 319.
	it.each([
		[600, FULL_COMPOSER_ROW],
		[502, FULL_COMPOSER_ROW],
		[501, { ...FULL_COMPOSER_ROW, showCost: false }],
		[459, { ...FULL_COMPOSER_ROW, showCost: false }],
		[458, BARE_METER],
		[383, BARE_METER],
		[382, TIGHT],
		[320, TIGHT],
		[319, TIGHT],
		[318, MOST_COLLAPSED],
		[280, MOST_COLLAPSED],
	])("at %ipx with the widest meter", (width, expected) => {
		expect(composerRowLayout(width, WIDEST)).toEqual(expected)
	})

	it("keeps the MCP and rules buttons in a 320px sidebar during a chat, with or without effort", () => {
		expect(composerRowLayout(320, WIDEST).inlinePanelButtons).toBe(true)
		const noEffort = { ...WIDEST, hasEffort: false }
		// Without an effort picker the pills stay roomy a little longer.
		expect(composerRowLayout(320, noEffort)).toEqual(BARE_METER)
		expect(composerRowLayout(318, noEffort)).toEqual(TIGHT)
		expect(composerRowLayout(287, noEffort)).toEqual(TIGHT)
		expect(composerRowLayout(286, noEffort)).toEqual(MOST_COLLAPSED)
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

	it("keeps the panel buttons on the home composer, which has no meter, down to 292px", () => {
		const home = { hasUsage: false, hasCost: false, hasCompactNudge: false, hasEffort: true, hasTask: false }
		expect(composerRowMinWidth(home, FULL_COMPOSER_ROW)).toBeLessThan(composerRowMinWidth(WIDEST, FULL_COMPOSER_ROW))
		expect(composerRowLayout(356, home)).toEqual(FULL_COMPOSER_ROW)
		expect(composerRowLayout(355, home).tightPills).toBe(true)
		expect(composerRowLayout(292, home).inlinePanelButtons).toBe(true)
		expect(composerRowLayout(291, home).inlinePanelButtons).toBe(false)
	})

	// Realistic labels: the where pill "No task" is only its icon, the model chip is "OpenAI QA"
	// (about 76px with its chevron) and the effort chip "Default" (about 64px).
	describe.each([
		["No task", WIDEST],
		["a task", WIDEST_WITH_TASK],
	])("at sidebar widths, with %s", (_label, content) => {
		const OPENAI_QA_WIDTH = 76
		it("keeps the MCP and rules buttons inline at 320, 420 and 480px", () => {
			for (const width of [320, 420, 480]) {
				expect(composerRowLayout(width, content).inlinePanelButtons, `width ${width}`).toBe(true)
			}
		})

		it("hides the cost at 320-480px, keeping the ring", () => {
			for (const width of [320, 420, 480]) {
				expect(composerRowLayout(width, content).showCost, `width ${width}`).toBe(false)
			}
		})

		it("goes tight at 320px but not at 420 or 480px", () => {
			expect(composerRowLayout(320, content).tightPills).toBe(true)
			expect(composerRowLayout(420, content).tightPills).toBe(false)
			expect(composerRowLayout(480, content).tightPills).toBe(false)
		})

		it("gives the model chip room for 'OpenAI QA' at 420 and 480px", () => {
			const w = COMPOSER_ROW_WIDTHS
			for (const width of [420, 480]) {
				const layout = composerRowLayout(width, content)
				// What the row has beyond its minimums goes to the model chip, which flexes the most.
				const configSpace = width - composerRowMinWidth(content, layout) + w.configMin
				expect(configSpace, `width ${width}`).toBeGreaterThanOrEqual(OPENAI_QA_WIDTH)
			}
		})
	})

	it("falls back to the most collapsed row when nothing fits", () => {
		expect(composerRowLayout(120, WIDEST)).toEqual(MOST_COLLAPSED)
	})
})
