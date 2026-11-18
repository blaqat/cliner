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

/** The panel column beside the chat. */
export const PANEL_COLUMN_WIDTH = 280
/** The panel is a column once the chat keeps its minimum room beside it; below that it's the summary line. */
export const PANEL_COLUMN_MIN_WIDTH = MAIN_MIN_WIDTH + PANEL_COLUMN_WIDTH

const HIDDEN_KEY = "threadPanel.hiddenSections"
const FOLDED_KEY = "threadPanel.foldedSections"
const COLUMN_KEY = "threadPanel.columnOpen"
const LINE_KEY = "threadPanel.lineOpen"

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
	/** Wide: the column shows (open when wide until closed, then remembered). */
	columnOpen: boolean
	/** Narrow: the summary line is opened in place (closed until opened, then remembered). */
	lineOpen: boolean
}

let prefs: ThreadPanelPrefs = loadPrefs()
const listeners = new Set<() => void>()

function loadPrefs(): ThreadPanelPrefs {
	return {
		hidden: readSections(HIDDEN_KEY),
		folded: readSections(FOLDED_KEY),
		columnOpen: read(COLUMN_KEY) !== "0",
		lineOpen: read(LINE_KEY) === "1",
	}
}

function setPrefs(next: Partial<ThreadPanelPrefs>): void {
	prefs = { ...prefs, ...next }
	if (next.hidden) write(HIDDEN_KEY, JSON.stringify(next.hidden))
	if (next.folded) write(FOLDED_KEY, JSON.stringify(next.folded))
	if (next.columnOpen !== undefined) write(COLUMN_KEY, next.columnOpen ? "1" : "0")
	if (next.lineOpen !== undefined) write(LINE_KEY, next.lineOpen ? "1" : "0")
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
		setColumnOpen: useCallback((open: boolean) => setPrefs({ columnOpen: open }), []),
		setLineOpen: useCallback((open: boolean) => setPrefs({ lineOpen: open }), []),
	}
}
