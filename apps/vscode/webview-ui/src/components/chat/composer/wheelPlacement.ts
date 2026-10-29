/** One wheel row, the menus' 24px. */
export const WHEEL_ROW_HEIGHT = 24
/** Rows the wheel shows when the window has room: the pick, two above, two below. */
export const WHEEL_MAX_ROWS = 5
/** The wheel never comes closer than this to a window edge. */
export const WHEEL_VIEWPORT_MARGIN = 4

/**
 * The most rows that fit `available` px: odd (so the pick has a center), at most `max`, at least 1.
 * A short window shows fewer rows rather than clipping any.
 */
export function wheelRowCount(available: number, max = WHEEL_MAX_ROWS): number {
	let rows = Math.min(max, Math.floor(available / WHEEL_ROW_HEIGHT))
	if (rows % 2 === 0) rows -= 1
	return Math.max(1, rows)
}

export interface WheelPlacementInput {
	/** The chip text the wheel came from (viewport coordinates). */
	anchor: { left: number; top: number; height: number }
	viewport: { width: number; height: number }
	/** The popup's width and the parts around the wheel: above it (border, padding, permissions) and below it (footer). */
	popup: { width: number; above: number; below: number }
	/** Left padding of a wheel row, so a row's text (not its edge) lines up with the chip text. */
	rowInset: number
	/** No wheel (permissions only, or the per-action list): the popup opens above the anchor like a menu. */
	noWheel?: boolean
	maxRows?: number
}

export interface WheelPlacement {
	top: number
	left: number
	rows: number
	/** Shifts the wheel column right inside a popup that had to move left to stay on screen. */
	columnOffset: number
	/** The center row sits exactly over the chip text, so the chip hides its own copy. */
	aligned: boolean
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

/**
 * Where the wheel popup goes: the center row's text exactly over the chip text it came from,
 * unless that would leave the window. Then it shifts (up near the bottom edge) and stays fully on
 * screen; a short window gets fewer rows.
 */
export function placeWheel({
	anchor,
	viewport,
	popup,
	rowInset,
	noWheel = false,
	maxRows = WHEEL_MAX_ROWS,
}: WheelPlacementInput): WheelPlacement {
	const margin = WHEEL_VIEWPORT_MARGIN
	const room = viewport.height - 2 * margin - popup.above - popup.below
	const rows = noWheel ? 0 : wheelRowCount(room, maxRows)
	const height = popup.above + rows * WHEEL_ROW_HEIGHT + popup.below
	const idealTop = noWheel
		? anchor.top - height - 2
		: anchor.top + anchor.height / 2 - (popup.above + Math.floor(rows / 2) * WHEEL_ROW_HEIGHT + WHEEL_ROW_HEIGHT / 2)
	const top = Math.max(margin, Math.min(idealTop, viewport.height - height - margin))
	const idealLeft = anchor.left - rowInset
	const left = clamp(idealLeft, margin, Math.max(margin, viewport.width - popup.width - margin))
	// A popup pushed left keeps its wheel column under the chip text, as long as the column still has room.
	const columnOffset = clamp(idealLeft - left, 0, Math.max(0, popup.width - 96))
	const aligned = !noWheel && Math.abs(top - idealTop) < 0.5 && Math.abs(left + columnOffset - idealLeft) < 0.5
	return { top, left, rows, columnOffset, aligned }
}
