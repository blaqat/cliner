import { type RefObject, useLayoutEffect, useMemo, useState } from "react"

/**
 * What the composer's bottom row shows at its current width. The where and model pills truncate
 * first (CSS, down to the minimums below); once they reach them, the meter's extras hide in order.
 * Below the last step the pills keep shrinking toward their icons.
 */
export interface ComposerRowLayout {
	/** The chat cost next to the context ring. Hidden first; it stays in the ring's details. */
	showCost: boolean
	/** The "Compact" pill at high usage. Next to go; Compact stays in the ring's details. */
	inlineCompactNudge: boolean
}

/** What the row has to fit; absent items need no room and cost nothing to hide. */
export interface ComposerRowContent {
	hasUsage: boolean
	hasCost: boolean
	hasCompactNudge: boolean
}

const LAYOUT_STEPS: readonly ComposerRowLayout[] = [
	{ showCost: true, inlineCompactNudge: true },
	{ showCost: false, inlineCompactNudge: true },
	{ showCost: false, inlineCompactNudge: false },
]

export const FULL_COMPOSER_ROW = LAYOUT_STEPS[0]

/**
 * Item widths in px, measured in Chromium with the VS Code font (see ComposerBottomRow.stories).
 * Pills count at the width where they still show a few characters.
 */
export const COMPOSER_ROW_WIDTHS = {
	/** px-3 on both sides (rem-based; VS Code's root font is 13px). */
	padding: 20,
	/** gap-1.5, rem-based too. */
	rowGap: 5,
	groupGap: 4,
	/** The ＋ menu button. */
	plus: 20,
	/** The where pill truncated to a few characters ("◇ No…▾"). */
	whereMin: 40,
	/** The model + effort pill truncated to a few characters. */
	modelMin: 56,
	ring: 22,
	/** Includes its gap after the ring. */
	cost: 43,
	/** Includes its gap before the ring. */
	compactNudge: 76,
	/** The approvals shield and its count. */
	approvals: 28,
	modeSwitch: 65,
} as const

/** Smallest row width (border box) that fits `content` in `layout`. */
export function composerRowMinWidth(content: ComposerRowContent, layout: ComposerRowLayout): number {
	const w = COMPOSER_ROW_WIDTHS
	const group = w.plus + w.whereMin + w.modelMin + 2 * w.groupGap
	const usage = content.hasUsage
		? w.rowGap +
			w.ring +
			(content.hasCost && layout.showCost ? w.cost : 0) +
			(content.hasCompactNudge && layout.inlineCompactNudge ? w.compactNudge : 0)
		: 0
	return w.padding + group + usage + w.rowGap + w.approvals + w.rowGap + w.modeSwitch
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
	const { hasUsage, hasCost, hasCompactNudge } = content
	// LAYOUT_STEPS entries are stable, so this only changes when a breakpoint is crossed.
	return useMemo(
		() => composerRowLayout(width, { hasUsage, hasCost, hasCompactNudge }),
		[width, hasUsage, hasCost, hasCompactNudge],
	)
}
