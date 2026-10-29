/** One wheel row: the chip's own line height (h-5), so the rolling text matches the chip text. */
export const WHEEL_ROW_HEIGHT = 20
/** Rows the wheel shows when the window has room: the pick and up to four neighbours. */
export const WHEEL_MAX_ROWS = 5
/** Neighbours preferred on each side of the pick (more go above when there's no room below). */
export const WHEEL_SIDE_ROWS = 2
/** The wheel never comes closer than this to a window edge. */
export const WHEEL_VIEWPORT_MARGIN = 4

export interface WheelPlacementInput {
	/** The chip text the wheel came from (viewport coordinates). */
	anchor: { left: number; top: number; height: number }
	viewport: { width: number; height: number }
	/** The wheel's width (icon actions plus rolling text) and the height of what hangs above it (approvals). */
	popup: { width: number; header: number }
	/** Left padding of a wheel row, so a row's text (not its edge) lines up with the chip text. */
	rowInset: number
	/** Width of what sits left of the rolling text on the pick's line (the icon actions). */
	lead?: number
	/** How many choices there are and which is picked (decides which way the wheel rolls without room below). */
	count?: number
	index?: number
	/** No wheel (approvals only, or a locked effort): it opens just above the anchor. */
	noWheel?: boolean
	maxRows?: number
}

export interface WheelPlacement {
	top: number
	left: number
	/** Neighbour rows shown above and below the pick. */
	above: number
	below: number
	/** The pick's row sits exactly over the chip text, so the chip hides its own copy. */
	aligned: boolean
	/**
	 * Rolled upside down: the choices after the pick sit above it. Used when there's no room below
	 * the chip and more choices follow the pick than precede it, so they can still show.
	 */
	flip: boolean
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

/**
 * Where the rolling text goes: the pick's row exactly over the chip text (the text stays put), with
 * up to two neighbours above and below. Near the bottom edge the rows below give way and more go
 * above, so it always stays on screen; a short window shows fewer neighbours. Sideways it shifts
 * only as far as needed to stay on screen.
 */
export function placeWheel({
	anchor,
	viewport,
	popup,
	rowInset,
	lead = 0,
	count = WHEEL_MAX_ROWS,
	index = 0,
	noWheel = false,
	maxRows = WHEEL_MAX_ROWS,
}: WheelPlacementInput): WheelPlacement {
	const margin = WHEEL_VIEWPORT_MARGIN
	const idealLeft = anchor.left - rowInset - lead
	const left = clamp(idealLeft, margin, Math.max(margin, viewport.width - popup.width - margin))
	if (noWheel) {
		const top = clamp(anchor.top - popup.header - 2, margin, Math.max(margin, viewport.height - popup.header - margin))
		return { top, left, above: 0, below: 0, aligned: false, flip: false }
	}
	const rowTop = anchor.top + anchor.height / 2 - WHEEL_ROW_HEIGHT / 2
	const fitBelow = Math.max(0, Math.floor((viewport.height - margin - (rowTop + WHEEL_ROW_HEIGHT)) / WHEEL_ROW_HEIGHT))
	const fitAbove = Math.max(0, Math.floor((rowTop - margin - popup.header) / WHEEL_ROW_HEIGHT))
	const neighbours = Math.max(0, count - 1)
	const before = Math.min(Math.max(0, index), neighbours)
	const after = neighbours - before
	const cramped = fitBelow < Math.min(WHEEL_SIDE_ROWS, neighbours)
	// Short of room below, roll the way that shows the most choices above the pick.
	const flip = cramped && after > before
	const below = Math.min(WHEEL_SIDE_ROWS, fitBelow, maxRows - 1, flip ? before : after, neighbours)
	// Cramped, the rows above hold only choices that exist (no empty rows sticking out of the composer).
	const above = Math.min(maxRows - 1 - below, fitAbove, cramped ? (flip ? after : before) : WHEEL_SIDE_ROWS, neighbours)
	// The approvals row hangs above the wheel (outside its box), so it only needs room up there.
	const idealTop = rowTop - above * WHEEL_ROW_HEIGHT
	const height = (above + 1 + below) * WHEEL_ROW_HEIGHT
	const top = clamp(idealTop, margin + popup.header, Math.max(margin + popup.header, viewport.height - height - margin))
	const aligned = Math.abs(top - idealTop) < 0.5 && Math.abs(left - idealLeft) < 0.5
	return { top, left, above, below, aligned, flip }
}
