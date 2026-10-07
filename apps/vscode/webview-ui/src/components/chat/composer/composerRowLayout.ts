import { type RefObject, useLayoutEffect, useMemo, useState } from "react"

/**
 * What the composer's bottom row shows at its current width. The pickers truncate first (CSS);
 * once they reach their minimum, secondary items collapse one at a time, in this order.
 */
export interface ComposerRowLayout {
	/** The chat cost next to the context ring. Hidden first; it stays in the ring's details. */
	showCost: boolean
	/** The "Compact" pill at high usage. Next to go; Compact stays in the ring's details. */
	inlineCompactNudge: boolean
	/** Effort and approvals fold into one "…" menu. */
	collapsePickers: boolean
	/** Last, the configuration picker joins them, rather than shrinking to its chevron. */
	collapseConfig: boolean
}

/** What the row has to fit; absent items need no room and cost nothing to "collapse". */
export interface ComposerRowContent {
	hasUsage: boolean
	hasCost: boolean
	hasCompactNudge: boolean
	hasEffort: boolean
}

const LAYOUT_STEPS: readonly ComposerRowLayout[] = [
	{ showCost: true, inlineCompactNudge: true, collapsePickers: false, collapseConfig: false },
	{ showCost: false, inlineCompactNudge: true, collapsePickers: false, collapseConfig: false },
	{ showCost: false, inlineCompactNudge: false, collapsePickers: false, collapseConfig: false },
	{ showCost: false, inlineCompactNudge: false, collapsePickers: true, collapseConfig: false },
	{ showCost: false, inlineCompactNudge: false, collapsePickers: true, collapseConfig: true },
]

export const FULL_COMPOSER_ROW = LAYOUT_STEPS[0]

/**
 * Item widths in px, measured in Chromium with the VS Code font (see ComposerBottomRow.stories).
 * Pickers count at their truncated minimum.
 */
export const COMPOSER_ROW_WIDTHS = {
	/** px-3 on both sides (rem-based; VS Code's root font is 13px). */
	padding: 20,
	/** gap-1.5, rem-based too. */
	rowGap: 5,
	groupGap: 4,
	/** @, +, MCP servers and rules, together. */
	icons: 74,
	configMin: 56,
	effortMin: 44,
	approvals: 28,
	overflow: 21,
	ring: 22,
	/** Includes its gap after the ring. */
	cost: 43,
	/** Includes its gap before the ring. */
	compactNudge: 76,
	modeSwitch: 65,
} as const

/** Smallest row width (border box) that fits `content` in `layout`. */
export function composerRowMinWidth(content: ComposerRowContent, layout: ComposerRowLayout): number {
	const w = COMPOSER_ROW_WIDTHS
	const pickers = [
		w.icons,
		layout.collapseConfig ? 0 : w.configMin,
		!layout.collapsePickers && content.hasEffort ? w.effortMin : 0,
		layout.collapsePickers ? 0 : w.approvals,
		layout.collapsePickers ? w.overflow : 0,
	].filter(Boolean)
	// The icons count as four items for the gaps between them.
	const groupWidth = pickers.reduce((sum, width) => sum + width, 0) + (pickers.length + 2) * w.groupGap
	const usage = content.hasUsage
		? w.rowGap +
			w.ring +
			(content.hasCost && layout.showCost ? w.cost : 0) +
			(content.hasCompactNudge && layout.inlineCompactNudge ? w.compactNudge : 0)
		: 0
	return w.padding + groupWidth + usage + w.rowGap + w.modeSwitch
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
	const { hasUsage, hasCost, hasCompactNudge, hasEffort } = content
	// LAYOUT_STEPS entries are stable, so this only changes when a breakpoint is crossed.
	return useMemo(
		() => composerRowLayout(width, { hasUsage, hasCost, hasCompactNudge, hasEffort }),
		[width, hasUsage, hasCost, hasCompactNudge, hasEffort],
	)
}
