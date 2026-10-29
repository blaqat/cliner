import { type RefObject, useLayoutEffect, useMemo, useState } from "react"

/**
 * What the composer's bottom row shows at its current width. The row is 📎 on the left, then on
 * the right the Compact chip (near the limit), the context ring, the "Model · Effort" chip and the
 * Send button that carries the mode. In the order things give way:
 * 1. The model name in the chip truncates (CSS, down to the minimum below).
 * 2. The Compact chip drops its label and token count, keeping its icon (it never hides while the
 *    context is nearly full).
 * 3. The chip goes tight: the model name may drop to a few characters.
 * 📎, the ring, the effort text and Send never hide.
 */
export interface ComposerRowLayout {
	/** The Compact chip shows "Compact 699k"; when false it is its icon alone. */
	inlineCompactNudge: boolean
	/** The model/effort chip may shrink below its usual minimum. */
	tightChip: boolean
}

/** What the row has to fit; absent items need no room. */
export interface ComposerRowContent {
	hasUsage: boolean
	hasCompactNudge: boolean
	/** The model has reasoning, so the chip has its effort text. */
	hasEffort: boolean
	/** The agent is running: Send is split into steer and interject. */
	running?: boolean
}

const LAYOUT_STEPS: readonly ComposerRowLayout[] = [
	{ inlineCompactNudge: true, tightChip: false },
	{ inlineCompactNudge: false, tightChip: false },
	{ inlineCompactNudge: false, tightChip: true },
]

export const FULL_COMPOSER_ROW = LAYOUT_STEPS[0]

/** Item widths in px (VS Code font, 13px root), measured in Chromium (see ComposerBottomRow.stories). */
export const COMPOSER_ROW_WIDTHS = {
	/** px-3 on both sides. */
	padding: 20,
	/** gap-1.5. */
	rowGap: 5,
	/** The 📎 button. */
	attach: 20,
	/** The 14px ring and its padding. */
	ring: 18,
	/** "⤡ Compact 699k". */
	compactNudge: 92,
	/** The Compact chip as its icon. */
	compactNudgeIcon: 22,
	/** The model chip at a still-readable name ("Opus 4…") and its effort text ("· High ⌄"). */
	chipMin: 104,
	/** Tight: a few characters of the model name. */
	chipTight: 72,
	/** Without effort the chip ends in the permissions icon instead of "· High". */
	effortSaving: 24,
	/** "Act ↑ | ⌄". */
	send: 62,
	/** Steer, interject and "Act ⌄" while running. */
	sendRunning: 82,
} as const

/** Smallest row width (border box) that fits `content` in `layout`. */
export function composerRowMinWidth(content: ComposerRowContent, layout: ComposerRowLayout): number {
	const w = COMPOSER_ROW_WIDTHS
	const usage = content.hasUsage
		? w.rowGap +
			w.ring +
			(content.hasCompactNudge ? w.rowGap + (layout.inlineCompactNudge ? w.compactNudge : w.compactNudgeIcon) : 0)
		: 0
	const chip = (layout.tightChip ? w.chipTight : w.chipMin) - (content.hasEffort ? 0 : w.effortSaving)
	return w.padding + w.attach + usage + w.rowGap + chip + w.rowGap + (content.running ? w.sendRunning : w.send)
}

/** The fullest layout that fits a measured row width; unknown widths (not laid out yet, jsdom) get the full row. */
export function composerRowLayout(width: number | undefined, content: ComposerRowContent): ComposerRowLayout {
	if (!width) {
		return FULL_COMPOSER_ROW
	}
	return LAYOUT_STEPS.find((layout) => composerRowMinWidth(content, layout) <= width) ?? LAYOUT_STEPS[LAYOUT_STEPS.length - 1]
}

/** The element's border-box width, tracked with a ResizeObserver; undefined until measured. */
export function useElementWidth(ref: RefObject<HTMLElement | null>): number | undefined {
	const [width, setWidth] = useState<number>()
	useLayoutEffect(() => {
		const element = ref.current
		if (!element || typeof ResizeObserver === "undefined") {
			return
		}
		setWidth(element.getBoundingClientRect().width)
		const observer = new ResizeObserver(([entry]) => {
			setWidth(entry.borderBoxSize?.[0]?.inlineSize ?? entry.target.getBoundingClientRect().width)
		})
		observer.observe(element)
		return () => observer.disconnect()
	}, [ref])
	return width
}

/** `composerRowLayout` driven by the row element's measured width. */
export function useComposerRowLayout(ref: RefObject<HTMLElement | null>, content: ComposerRowContent): ComposerRowLayout {
	const width = useElementWidth(ref)
	const { hasUsage, hasCompactNudge, hasEffort, running } = content
	// LAYOUT_STEPS entries are stable, so this only changes when a breakpoint is crossed.
	return useMemo(
		() => composerRowLayout(width, { hasUsage, hasCompactNudge, hasEffort, running }),
		[width, hasUsage, hasCompactNudge, hasEffort, running],
	)
}
