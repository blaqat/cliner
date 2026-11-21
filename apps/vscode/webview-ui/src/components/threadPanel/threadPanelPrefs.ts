import { useCallback, useSyncExternalStore } from "react"
import { MAIN_MIN_WIDTH } from "@/components/oneView/layoutPrefs"

/** The thread panel's sections, in the order they stack. */
export type PanelSection = "where" | "agents" | "notes" | "context"
export const PANEL_SECTIONS: readonly PanelSection[] = ["where", "agents", "notes", "context"]
export const PANEL_SECTION_LABEL: Record<PanelSection, string> = {
	where: "Branch & changes",
	agents: "Agents",
	notes: "Notes",
	context: "Context & cost",
}

/** The panel card beside the messages. */
export const PANEL_WIDTH = 272
/** The gap around the card beside the messages. */
const PANEL_GUTTER = 12
/** The panel sits beside the messages once they keep their minimum room; below that it opens over them. */
export const PANEL_MIN_ROOM = MAIN_MIN_WIDTH + PANEL_WIDTH + PANEL_GUTTER
/** A side thread's column beside Main. */
export const SIDE_COLUMN_WIDTH = 300
/** A side thread opens beside Main once Main keeps its minimum room; below that it opens on its own. */
export const SIDE_COLUMN_MIN_ROOM = MAIN_MIN_WIDTH + SIDE_COLUMN_WIDTH

const HIDDEN_KEY = "threadPanel.hiddenSections"
const FOLDED_KEY = "threadPanel.foldedSections"
const OPEN_KEY = "threadPanel.columnOpen"

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
		// Best effort: the choice still holds for this session.
	}
}

function readSections(key: string): PanelSection[] {
	try {
		const value = JSON.parse(read(key) ?? "[]")
		return Array.isArray(value) ? PANEL_SECTIONS.filter((section) => value.includes(section)) : []
	} catch {
		return []
	}
}

export interface ThreadPanelPrefs {
	/** Sections the user turned off. */
	hidden: PanelSection[]
	/** Sections folded to their header. */
	folded: PanelSection[]
	/** The header toggle: the panel shows beside the messages when there's room (open until hidden, then remembered). */
	open: boolean
}

let prefs: ThreadPanelPrefs = loadPrefs()
const listeners = new Set<() => void>()

function loadPrefs(): ThreadPanelPrefs {
	return {
		hidden: readSections(HIDDEN_KEY),
		folded: readSections(FOLDED_KEY),
		open: read(OPEN_KEY) !== "0",
	}
}

function setPrefs(next: Partial<ThreadPanelPrefs>): void {
	prefs = { ...prefs, ...next }
	if (next.hidden) write(HIDDEN_KEY, JSON.stringify(next.hidden))
	if (next.folded) write(FOLDED_KEY, JSON.stringify(next.folded))
	if (next.open !== undefined) write(OPEN_KEY, next.open ? "1" : "0")
	for (const listener of listeners) listener()
}

function toggled(list: PanelSection[], section: PanelSection): PanelSection[] {
	return list.includes(section) ? list.filter((item) => item !== section) : [...list, section]
}

/** Re-reads saved prefs; tests only. */
export function reloadThreadPanelPrefs(): void {
	prefs = loadPrefs()
	for (const listener of listeners) listener()
}

export function useThreadPanelPrefs() {
	const current = useSyncExternalStore(
		(listener) => {
			listeners.add(listener)
			return () => {
				listeners.delete(listener)
			}
		},
		() => prefs,
	)
	return {
		...current,
		toggleShown: useCallback((section: PanelSection) => setPrefs({ hidden: toggled(prefs.hidden, section) }), []),
		showAll: useCallback(() => setPrefs({ hidden: [] }), []),
		toggleFolded: useCallback((section: PanelSection) => setPrefs({ folded: toggled(prefs.folded, section) }), []),
		setOpen: useCallback((open: boolean) => setPrefs({ open }), []),
	}
}

/**
 * The panel on screen right now (session only): whether a thread with a panel is showing,
 * whether it has room beside the messages, and, when it doesn't, whether the toggle opened
 * it over them. The header toggle and the frame around the messages share it.
 */
export interface ThreadPanelUi {
	available: boolean
	room: boolean
	overlayOpen: boolean
	/** The header toggle, which the overlay hangs from. */
	toggle: HTMLElement | null
}

let ui: ThreadPanelUi = { available: false, room: false, overlayOpen: false, toggle: null }
const uiListeners = new Set<() => void>()

export function setThreadPanelUi(next: Partial<ThreadPanelUi>): void {
	if (Object.entries(next).every(([key, value]) => ui[key as keyof ThreadPanelUi] === value)) return
	ui = { ...ui, ...next }
	for (const listener of uiListeners) listener()
}

export function useThreadPanelUi(): ThreadPanelUi {
	return useSyncExternalStore(
		(listener) => {
			uiListeners.add(listener)
			return () => {
				uiListeners.delete(listener)
			}
		},
		() => ui,
	)
}

/** Tests only. */
export function resetThreadPanelUi(): void {
	ui = { available: false, room: false, overlayOpen: false, toggle: null }
	for (const listener of uiListeners) listener()
}
