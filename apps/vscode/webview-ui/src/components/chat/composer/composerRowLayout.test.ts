import { describe, expect, it } from "vitest"
import {
	COMPOSER_ROW_WIDTHS,
	type ComposerRowContent,
	composerRowLayout,
	composerRowMinWidth,
	FULL_COMPOSER_ROW,
} from "./composerRowLayout"

const nearlyFull: ComposerRowContent = { hasUsage: true, hasCompactNudge: true, hasEffort: true }
const chat: ComposerRowContent = { hasUsage: true, hasCompactNudge: false, hasEffort: true }
const home: ComposerRowContent = { hasUsage: false, hasCompactNudge: false, hasEffort: true }

describe("composerRowLayout", () => {
	it("shows everything before the row is measured", () => {
		expect(composerRowLayout(undefined, nearlyFull)).toBe(FULL_COMPOSER_ROW)
		expect(FULL_COMPOSER_ROW).toEqual({ inlineCompactNudge: true, compactEffort: false, tightChip: false })
	})

	it("gives way in order: the Compact label, then the effort text, then the chip goes tight", () => {
		const fullRow = { inlineCompactNudge: true, compactEffort: false, tightChip: false }
		const iconNudgeRow = { inlineCompactNudge: false, compactEffort: false, tightChip: false }
		const compactRow = { inlineCompactNudge: false, compactEffort: true, tightChip: false }
		const tightRow = { inlineCompactNudge: false, compactEffort: true, tightChip: true }
		const full = composerRowMinWidth(nearlyFull, fullRow)
		const iconNudge = composerRowMinWidth(nearlyFull, iconNudgeRow)
		const compact = composerRowMinWidth(nearlyFull, compactRow)
		const tight = composerRowMinWidth(nearlyFull, tightRow)
		expect(full).toBeGreaterThan(iconNudge)
		expect(iconNudge).toBeGreaterThan(compact)
		expect(compact).toBeGreaterThan(tight)
		expect(composerRowLayout(full, nearlyFull)).toEqual(fullRow)
		expect(composerRowLayout(full - 1, nearlyFull)).toEqual(iconNudgeRow)
		expect(composerRowLayout(iconNudge - 1, nearlyFull)).toEqual(compactRow)
		expect(composerRowLayout(compact - 1, nearlyFull)).toEqual(tightRow)
		// Nothing fits: the most collapsed row, never a wrap.
		expect(composerRowLayout(120, nearlyFull)).toEqual(tightRow)
	})

	it("fits the whole row, Compact label included, in a 340px sidebar", () => {
		expect(composerRowLayout(340, nearlyFull)).toEqual(FULL_COMPOSER_ROW)
		expect(composerRowLayout(300, chat)).toEqual(FULL_COMPOSER_ROW)
		expect(composerRowLayout(260, home)).toEqual(FULL_COMPOSER_ROW)
	})

	it("needs room for the ring and the Compact chip only in a chat near the limit", () => {
		const w = COMPOSER_ROW_WIDTHS
		expect(composerRowMinWidth(chat, FULL_COMPOSER_ROW) - composerRowMinWidth(home, FULL_COMPOSER_ROW)).toBe(
			w.rowGap + w.ring,
		)
		expect(composerRowMinWidth(nearlyFull, FULL_COMPOSER_ROW) - composerRowMinWidth(chat, FULL_COMPOSER_ROW)).toBe(
			w.rowGap + w.compactNudge,
		)
	})

	it("makes room for the effort text only when the model has reasoning, and for steer/interject while running", () => {
		const noEffort = { ...chat, hasEffort: false }
		expect(composerRowMinWidth(chat, FULL_COMPOSER_ROW) - composerRowMinWidth(noEffort, FULL_COMPOSER_ROW)).toBe(
			COMPOSER_ROW_WIDTHS.effortSaving,
		)
		expect(
			composerRowMinWidth({ ...chat, running: true }, FULL_COMPOSER_ROW) - composerRowMinWidth(chat, FULL_COMPOSER_ROW),
		).toBe(COMPOSER_ROW_WIDTHS.sendRunning - COMPOSER_ROW_WIDTHS.send)
	})
})
