/** Where the thread list sits in one view. "top" is the strip of thread chips. */
export type Dock = "left" | "right" | "top"

/** At or above this webview width the list can sit beside the chat; below it, it is always the top strip. */
export const WIDE_MIN_WIDTH = 560
export const LIST_MIN_WIDTH = 200
export const LIST_MAX_WIDTH = 480
export const LIST_DEFAULT_WIDTH = 260
/** The chat keeps at least this much room beside a side list. */
export const MAIN_MIN_WIDTH = 320
/** One arrow-key press on the resize handle. */
export const LIST_RESIZE_STEP = 16

const DOCK_KEY = "oneView.dock"
const WIDTH_KEY = "oneView.listWidth"
const HIDDEN_KEY = "oneView.listHidden"

/** Where the list actually goes: the user's dock when the webview is wide, the strip when it's narrow. */
export function resolvePlacement(width: number, dock: Dock): Dock {
	return width < WIDE_MIN_WIDTH ? "top" : dock
}

/** A side list width that leaves the chat its minimum room. */
export function clampListWidth(width: number, containerWidth: number): number {
	const max = Math.max(LIST_MIN_WIDTH, Math.min(LIST_MAX_WIDTH, containerWidth - MAIN_MIN_WIDTH))
	return Math.round(Math.min(max, Math.max(LIST_MIN_WIDTH, width)))
}

/** The dock under a dragged grip: the top quarter docks on top, otherwise the nearer side. */
export function dockAt(x: number, y: number, rect: { left: number; top: number; width: number; height: number }): Dock {
	if (y - rect.top < rect.height * 0.25) return "top"
	return x - rect.left < rect.width / 2 ? "left" : "right"
}

function read(key: string): string | null {
	try {
		return localStorage.getItem(key)
	} catch {
		return null
	}
}

function write(key: string, value: string): void {
	try {
		localStorage.setItem(key, value)
	} catch {
		// Best effort: the layout still works for this session.
	}
}

export function readDock(): Dock {
	const value = read(DOCK_KEY)
	return value === "right" || value === "top" ? value : "left"
}

export function writeDock(dock: Dock): void {
	write(DOCK_KEY, dock)
}

export function readListWidth(): number {
	const value = Number(read(WIDTH_KEY))
	return Number.isFinite(value) && value > 0 ? value : LIST_DEFAULT_WIDTH
}

export function writeListWidth(width: number): void {
	write(WIDTH_KEY, String(Math.round(width)))
}

export function readListHidden(): boolean {
	return read(HIDDEN_KEY) === "1"
}

export function writeListHidden(hidden: boolean): void {
	write(HIDDEN_KEY, hidden ? "1" : "0")
}
