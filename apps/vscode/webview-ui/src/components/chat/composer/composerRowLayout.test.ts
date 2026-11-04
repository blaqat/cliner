import { describe, expect, it } from "vitest"
import {
	COMPOSER_ROW_WIDTHS,
	type ComposerRowContent,
	composerChipMinWidth,
	composerRowLayout,
	composerRowMinWidth,
	FULL_COMPOSER_ROW,
} from "./composerRowLayout"

const nearlyFull: ComposerRowContent = { hasUsage: true, hasCompactNudge: true, hasEffort: true }
const chat: ComposerRowContent = { hasUsage: true, hasCompactNudge: false, hasEffort: true }
const home: ComposerRowContent = { hasUsage: false, hasCompactNudge: false, hasEffort: true }
const COLLAPSED = { inlineCompactNudge: false, compactEffort: true, tightChip: true, bareChip: true, hideModeSwitch: true }

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
		expect(composerRowLayout(tight, nearlyFull)).toEqual(tightRow)
	})

	it("past tight, the model name goes, then the Ask | Act switch", () => {
		const bareRow = { ...COLLAPSED, hideModeSwitch: undefined }
		const tightRow = { inlineCompactNudge: false, compactEffort: true, tightChip: true }
		const tight = composerRowMinWidth(chat, tightRow)
		const bare = composerRowMinWidth(chat, bareRow)
		expect(bare).toBeLessThan(tight)
		expect(composerRowMinWidth(chat, COLLAPSED)).toBeLessThan(bare)
		expect(composerRowLayout(tight - 1, chat)).toEqual(bareRow)
		expect(composerRowLayout(bare - 1, chat)).toEqual(COLLAPSED)
		// Nothing fits: the most collapsed row, never a wrap.
		expect(composerRowLayout(60, chat)).toEqual(COLLAPSED)
	})

	it("always leaves Send room, down to VS Code's narrowest sidebar", () => {
		// Rows are 27px narrower than the sidebar.
		for (const sidebar of [170, 190, 220, 250]) {
			for (const content of [home, chat, nearlyFull]) {
				for (const extra of [{}, { nextMessage: true }, { running: true }, { nextMessage: true, running: true }]) {
					const row = sidebar - 27
					const fitted = { ...content, ...extra }
					expect(composerRowMinWidth(fitted, composerRowLayout(row, fitted))).toBeLessThanOrEqual(row)
				}
			}
		}
	})

	it("fits the whole row, Compact label and Ask | Act switch included, in a 370px sidebar", () => {
		expect(composerRowLayout(370, nearlyFull)).toEqual(FULL_COMPOSER_ROW)
		// At 340 only the Compact label gives way.
		expect(composerRowLayout(340, nearlyFull)).toEqual({ inlineCompactNudge: false, compactEffort: false, tightChip: false })
		expect(composerRowLayout(300, chat)).toEqual(FULL_COMPOSER_ROW)
		expect(composerRowLayout(260, home)).toEqual(FULL_COMPOSER_ROW)
	})

	it("makes room for the armed marker, so the chip's floor never runs into Ask", () => {
		const armed = { ...chat, nextMessage: true }
		const w = COMPOSER_ROW_WIDTHS
		const fullRow = { inlineCompactNudge: false, compactEffort: false, tightChip: false }
		const compactRow = { inlineCompactNudge: false, compactEffort: true, tightChip: false }
		const tightRow = { inlineCompactNudge: false, compactEffort: true, tightChip: true }
		expect(composerChipMinWidth(armed, fullRow)).toBe(w.chipMin + w.nextMessage)
		expect(composerChipMinWidth(armed, compactRow)).toBe(w.chipCompact + w.nextMessageShort)
		// Tight, the marker takes the model name's room, so the armed row is no wider than any other.
		expect(composerRowMinWidth(armed, tightRow)).toBe(composerRowMinWidth(chat, tightRow))
		// Rows are 27px narrower than the sidebar. Near the limit, the 250px sidebar is the narrowest one that has to fit.
		for (const sidebar of [250, 280, 300, 320, 360, 400, 440, 480]) {
			const content = { ...nearlyFull, nextMessage: true }
			const width = sidebar - 27
			expect(composerRowMinWidth(content, composerRowLayout(width, content))).toBeLessThanOrEqual(width)
		}
		// Full words only once they fit.
		expect(composerRowLayout(280, armed).compactEffort).toBe(true)
		expect(composerRowLayout(370, armed).compactEffort).toBe(false)
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

	it("shrinks the Ask | Act switch to the current mode only on the tightest row", () => {
		const w = COMPOSER_ROW_WIDTHS
		const compactRow = { inlineCompactNudge: false, compactEffort: true, tightChip: false }
		const tightRow = { inlineCompactNudge: false, compactEffort: true, tightChip: true }
		expect(composerRowMinWidth(chat, compactRow) - composerRowMinWidth(chat, tightRow)).toBe(
			w.chipCompact - w.chipTight + w.modeSwitch - w.modeSwitchCompact,
		)
	})
})
