import { type RefObject, useLayoutEffect, useMemo, useState } from "react"

/**
 * What the composer's bottom row shows at its current width, in the order things give way:
 * 1. The task name in the where pill (a no-task pill is just its icon already) and the
 *    configuration picker truncate (CSS, down to the minimums below). The effort chip uses short
 *    labels (Default, Low, Med, High, XHigh), so it keeps its width until step 4.
 * 2. The chat cost hides; it stays in the ring's details.
 * 3. The Compact pill shrinks to its icon (it never hides while context is nearly full).
 * 4. The pills go tight: the where pill shows only its icon and the configuration and effort
 *    pickers drop to a few characters.
 * 5. Only then do the MCP servers and rules buttons fold into ＋ (as rows that open the same
 *    panels), so they stay visible in a 340px sidebar during a chat.
 * Below the last step the pills keep shrinking toward their chevrons. ＋, the workspace button, the
 * approvals shield, the ring and the Ask/Act switch never hide.
 */
export interface ComposerRowLayout {
	/** The MCP servers and rules buttons beside ＋. Last to go; when false they are rows in the ＋ menu. */
	inlinePanelButtons: boolean
	/** The chat cost next to the context ring. Hidden first; it stays in the ring's details. */
	showCost: boolean
	/** The "Compact" pill at high usage shows its label. Next to go: it shrinks to its icon. */
	inlineCompactNudge: boolean
	/** Icon-only where pill and lower picker minimums, to keep the MCP and rules buttons on the row. */
	tightPills: boolean
}

/** What the row has to fit; absent items need no room and cost nothing to hide. */
export interface ComposerRowContent {
	hasUsage: boolean
	hasCost: boolean
	hasCompactNudge: boolean
	/** The model has reasoning, so the effort picker shows. */
	hasEffort: boolean
	/** The where pill shows a task name; with no task it is just its icon. */
	hasTask: boolean
}

const LAYOUT_STEPS: readonly ComposerRowLayout[] = [
	{ inlinePanelButtons: true, showCost: true, inlineCompactNudge: true, tightPills: false },
	{ inlinePanelButtons: true, showCost: false, inlineCompactNudge: true, tightPills: false },
	{ inlinePanelButtons: true, showCost: false, inlineCompactNudge: false, tightPills: false },
	{ inlinePanelButtons: true, showCost: false, inlineCompactNudge: false, tightPills: true },
	{ inlinePanelButtons: false, showCost: false, inlineCompactNudge: false, tightPills: true },
]

export const FULL_COMPOSER_ROW = LAYOUT_STEPS[0]

/**
 * Item widths in px, measured in Chromium with the VS Code font (see ComposerBottomRow.stories).
 * Pills and pickers count at the width where they still show a few characters.
 */
export const COMPOSER_ROW_WIDTHS = {
	/** px-3 on both sides (rem-based; VS Code's root font is 13px). */
	padding: 20,
	/** gap-1.5, rem-based too. */
	rowGap: 5,
	groupGap: 4,
	/** The ＋ menu button (measured in VS Code: 26px with its padding). */
	plus: 26,
	/** The MCP servers button and the rules button, each the ＋'s size. */
	panelButton: 26,
	/** The workspace button left of the where pill, the ＋'s size. */
	workspace: 26,
	/** The where pill with no task: its icon alone (tasklist icon, padding and border). */
	whereIcon: 22,
	/** The where pill with a task, truncated to a few characters ("◇ Na…▾"). */
	whereNamed: 52,
	/** The configuration picker truncated to a still-readable name (about "OpenAI Q…"). */
	configMin: 72,
	/** The effort chip at its widest short label ("Default ▾"); it doesn't truncate until the pills go tight. */
	effortMin: 60,
	/** Tight pills: the where pill's icon alone, the configuration picker's and the effort chip's few characters. */
	configTight: 40,
	effortTight: 28,
	ring: 22,
	/** Includes its gap after the ring. */
	cost: 43,
	/** Includes its gap before the ring. */
	compactNudge: 76,
	/** The Compact pill as its icon alone on narrower rows, with its gap. */
	compactNudgeIcon: 22,
	/** The approvals shield and its count, right after the effort picker. */
	approvals: 28,
	modeSwitch: 65,
} as const

/** Smallest row width (border box) that fits `content` in `layout`. */
export function composerRowMinWidth(content: ComposerRowContent, layout: ComposerRowLayout): number {
	const w = COMPOSER_ROW_WIDTHS
	const pills = layout.tightPills
		? w.whereIcon + w.configTight + (content.hasEffort ? w.groupGap + w.effortTight : 0)
		: (content.hasTask ? w.whereNamed : w.whereIcon) + w.configMin + (content.hasEffort ? w.groupGap + w.effortMin : 0)
	const panelButtons = layout.inlinePanelButtons ? 2 * (w.panelButton + w.groupGap) : 0
	// ＋, [MCP, rules,] workspace, where, configuration, [effort,] shield: one gap between each.
	const group = w.plus + panelButtons + w.workspace + w.groupGap + pills + 3 * w.groupGap + w.approvals
	const usage = content.hasUsage
		? w.rowGap +
			w.ring +
			(content.hasCost && layout.showCost ? w.cost : 0) +
			(content.hasCompactNudge ? (layout.inlineCompactNudge ? w.compactNudge : w.compactNudgeIcon) : 0)
		: 0
	return w.padding + group + usage + w.rowGap + w.modeSwitch
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
	const { hasUsage, hasCost, hasCompactNudge, hasEffort, hasTask } = content
	// LAYOUT_STEPS entries are stable, so this only changes when a breakpoint is crossed.
	return useMemo(
		() => composerRowLayout(width, { hasUsage, hasCost, hasCompactNudge, hasEffort, hasTask }),
		[width, hasUsage, hasCost, hasCompactNudge, hasEffort, hasTask],
	)
}
