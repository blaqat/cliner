import type { ChangeWalkthrough, WalkthroughHunk, WalkthroughLineNote, WalkthroughScope } from "@shared/Walkthrough"

/** Notes and reviewed marks for one walkthrough layout. Stop ids are only stable within a source. */
export interface StopReview {
	notes: Record<string, string>
	reviewed: Record<string, boolean>
}

export interface ReviewRecord {
	overallNote?: string
	/** Notes on selections inside a hunk, keyed by lineNoteKey. Hunks are the same in every layout, so these are shared. */
	lineNotes?: Record<string, LineNoteEntry>
	fallback?: StopReview
	generated?: StopReview
	authored?: StopReview
}

/** Records per diff fingerprint. Usually one; a second means the changes moved and the old one awaits a refresh. */
export type ReviewStore = Record<string, ReviewRecord>

const KEY_PREFIX = "cline.walkthroughReview"

/** Authored docs share scope "authored" within a thread, so the id keeps their reviews apart. */
export const reviewStorageKey = (taskId: string, scope: WalkthroughScope, authoredId?: string) =>
	`${KEY_PREFIX}:${taskId}:${scope}${authoredId ? `:${authoredId}` : ""}`

export const EMPTY_STOP_REVIEW: StopReview = { notes: {}, reviewed: {} }

export function loadReviewStore(taskId: string, scope: WalkthroughScope, authoredId?: string): ReviewStore {
	try {
		const parsed: unknown = JSON.parse(localStorage.getItem(reviewStorageKey(taskId, scope, authoredId)) ?? "{}")
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as ReviewStore) : {}
	} catch {
		return {}
	}
}

export function saveReviewStore(taskId: string, scope: WalkthroughScope, authoredId: string | undefined, store: ReviewStore) {
	try {
		const key = reviewStorageKey(taskId, scope, authoredId)
		const kept = Object.fromEntries(Object.entries(store).filter(([, record]) => hasContent(record)))
		if (Object.keys(kept).length) localStorage.setItem(key, JSON.stringify(kept))
		else localStorage.removeItem(key)
	} catch {
		// Storage full or unavailable: review state just won't survive a reload.
	}
}

const filled = (notes: Record<string, string> = {}) => Object.values(notes).filter((note) => note.trim()).length

export interface LineNoteEntry {
	note: string
	/** The exact text selected, when it wasn't whole lines. */
	quote?: string
}

/** Selected body lines of one hunk, first to last. */
export interface LineRange {
	start: number
	end: number
}

/** A line note's key: the hunk's fingerprint (stable across layouts) and the selected body lines. */
export const lineNoteKey = (hunk: Pick<WalkthroughHunk, "fingerprint">, range: LineRange) =>
	`${hunk.fingerprint}:${range.start}-${range.end}`

/** Splits a key back into its hunk and lines (also reads a single-line `fingerprint:line`). */
export function parseLineNoteKey(key: string): ({ fingerprint: string } & LineRange) | undefined {
	const split = key.lastIndexOf(":")
	const match = /^(\d+)(?:-(\d+))?$/.exec(key.slice(split + 1))
	if (split < 0 || !match) return undefined
	const start = Number(match[1])
	const end = match[2] === undefined ? start : Number(match[2])
	return end >= start ? { fingerprint: key.slice(0, split), start, end } : undefined
}

/** Older builds stored the note text alone. */
export const lineNoteEntry = (value: LineNoteEntry | string | undefined): LineNoteEntry =>
	typeof value === "string" ? { note: value } : (value ?? { note: "" })

const filledLineNotes = (notes: ReviewRecord["lineNotes"] = {}) =>
	Object.values(notes).filter((value) => lineNoteEntry(value).note.trim()).length
const marked = (reviewed: Record<string, boolean> = {}) => Object.values(reviewed).filter(Boolean).length

export function hasContent(record: ReviewRecord | undefined): boolean {
	if (!record) return false
	return (
		!!record.overallNote?.trim() ||
		filledLineNotes(record.lineNotes) > 0 ||
		[record.fallback, record.generated, record.authored].some(
			(review) => filled(review?.notes) + marked(review?.reviewed) > 0,
		)
	)
}

/** Store key for notes a Regenerate could not place on the new layout of the same changes. */
export const previousLayoutKey = (fingerprint: string) => `${fingerprint}#previous-layout`

/** What a moved-away fingerprint still holds, for the "Changes moved" banner. */
export function summarizeStale(store: ReviewStore, fingerprint: string): { notes: number; reviewed: number } {
	let notes = 0
	let reviewed = 0
	for (const [key, record] of Object.entries(store)) {
		if (key === fingerprint || key === previousLayoutKey(fingerprint) || !hasContent(record)) continue
		notes +=
			(record.overallNote?.trim() ? 1 : 0) +
			filledLineNotes(record.lineNotes) +
			filled(record.fallback?.notes) +
			filled(record.generated?.notes) +
			filled(record.authored?.notes)
		reviewed += marked(record.fallback?.reviewed) + marked(record.generated?.reviewed) + marked(record.authored?.reviewed)
	}
	return { notes, reviewed }
}

/**
 * Keeps only the current fingerprint's record: what Refresh does once the user
 * accepts the new changes. Notes a Regenerate could not place on the current
 * changes survive until the user recovers or discards them.
 */
export function dropStale(store: ReviewStore, fingerprint: string): ReviewStore {
	const kept: ReviewStore = {}
	if (store[fingerprint]) kept[fingerprint] = store[fingerprint]
	const pending = previousLayoutKey(fingerprint)
	if (store[pending]) kept[pending] = store[pending]
	return kept
}

/** The notes (with their old stop titles) left behind by Regenerate for the current changes. */
export function unplacedNotes(store: ReviewStore, fingerprint: string): string[] {
	return Object.values(store[previousLayoutKey(fingerprint)]?.generated?.notes ?? {}).filter((note) => note.trim())
}

/** Appends the unplaced notes to the overall note and clears them. */
export function recoverUnplacedNotes(store: ReviewStore, fingerprint: string): ReviewStore {
	const notes = unplacedNotes(store, fingerprint)
	const { [previousLayoutKey(fingerprint)]: _removed, ...rest } = store
	if (!notes.length) return rest
	const record = rest[fingerprint] ?? {}
	const overallNote = [record.overallNote?.trim(), ...notes].filter(Boolean).join("\n\n")
	return { ...rest, [fingerprint]: { ...record, overallNote } }
}

/** Explicitly discards the unplaced notes. */
export function discardUnplacedNotes(store: ReviewStore, fingerprint: string): ReviewStore {
	const { [previousLayoutKey(fingerprint)]: _removed, ...rest } = store
	return rest
}

export function stopReviewFor(store: ReviewStore, walk: ChangeWalkthrough): StopReview {
	return store[walk.fingerprint]?.[walk.source] ?? EMPTY_STOP_REVIEW
}

const allStops = (walk: ChangeWalkthrough) => [...walk.chapters.flatMap((chapter) => chapter.stops), ...walk.support]

const sameSet = (a: string[], b: string[]) => a.length > 0 && a.length === b.length && a.every((id) => b.includes(id))

/**
 * Regenerate replaces the generated layout of the same changes with a new one
 * whose stop ids mean different stops. Notes and marks follow their stop when the
 * new layout has a stop over the same hunks, or with the same title, or one that
 * contains all of the old stop's hunks (notes only). A note that fits none stays
 * in a "previous layout" record the banner offers to recover or discard; it is
 * never dropped silently.
 */
export function migrateRegeneratedReview(store: ReviewStore, before: ChangeWalkthrough, after: ChangeWalkthrough): ReviewStore {
	const old = store[before.fingerprint]?.generated
	if (!old || before.source !== "generated" || before.fingerprint !== after.fingerprint) return store
	const target = allStops(after)
	const moved: StopReview = { notes: {}, reviewed: {} }
	const unplaced: Record<string, string> = {}
	for (const stop of allStops(before)) {
		const note = old.notes[stop.id]?.trim() ? old.notes[stop.id].trim() : undefined
		const reviewed = !!old.reviewed[stop.id]
		if (!note && !reviewed) continue
		const same =
			target.find((candidate) => sameSet(candidate.hunkIds, stop.hunkIds)) ??
			target.find((candidate) => candidate.title === stop.title)
		const container =
			same ??
			(note ? target.find((c) => stop.hunkIds.length > 0 && stop.hunkIds.every((id) => c.hunkIds.includes(id))) : undefined)
		if (!container) {
			if (note) unplaced[stop.id] = `${stop.title}: ${note}`
			continue
		}
		if (note) moved.notes[container.id] = [moved.notes[container.id], note].filter(Boolean).join("\n\n")
		if (reviewed && same) moved.reviewed[container.id] = true
	}
	const next: ReviewStore = { ...store }
	const pendingKey = previousLayoutKey(after.fingerprint)
	next[after.fingerprint] = { ...next[after.fingerprint], generated: moved }
	if (Object.keys(unplaced).length) {
		const existing = next[pendingKey]?.generated?.notes ?? {}
		const prefix = Object.keys(existing).length
		const added = Object.fromEntries(Object.entries(unplaced).map(([id, note]) => [`${prefix}:${id}`, note]))
		next[pendingKey] = { generated: { notes: { ...existing, ...added }, reviewed: {} } }
	}
	return next
}

/**
 * After the user's own revert the diff (and fingerprint) changes. Notes and marks
 * move to stops with the same title in the same kind of layout; anything that
 * can't be placed keeps the old record as stale, so the "Changes moved" banner
 * still offers it until a refresh.
 */
export function carryOverReview(store: ReviewStore, before: ChangeWalkthrough, after: ChangeWalkthrough): ReviewStore {
	const old = store[before.fingerprint]
	if (!old || before.fingerprint === after.fingerprint) return store
	const oldStops = old[before.source] ?? EMPTY_STOP_REVIEW
	const target = before.source === after.source ? allStops(after) : []
	const moved: StopReview = { notes: {}, reviewed: {} }
	let lost = false
	for (const stop of allStops(before)) {
		const note = oldStops.notes[stop.id]?.trim() ? oldStops.notes[stop.id] : undefined
		const reviewed = !!oldStops.reviewed[stop.id]
		if (!note && !reviewed) continue
		const match = target.find((candidate) => candidate.title === stop.title)
		if (!match) {
			// A reviewed stop that disappeared needs no rescue; a note does.
			if (note) lost = true
			continue
		}
		if (note) moved.notes[match.id] = note
		if (reviewed) moved.reviewed[match.id] = true
	}
	const otherSource = before.source === "generated" ? "fallback" : "generated"
	if (hasContent({ [otherSource]: old[otherSource] })) lost = true
	// Line notes follow their hunk when it is still there (a revert elsewhere leaves it untouched).
	const surviving = new Set(after.hunks.map((hunk) => hunk.fingerprint))
	const lineNotes: Record<string, LineNoteEntry> = {}
	for (const [key, value] of Object.entries(old.lineNotes ?? {})) {
		if (!lineNoteEntry(value).note.trim()) continue
		if (surviving.has(parseLineNoteKey(key)?.fingerprint ?? "")) lineNotes[key] = lineNoteEntry(value)
		else lost = true
	}
	const next: ReviewStore = { ...store }
	if (!lost) delete next[before.fingerprint]
	next[after.fingerprint] = {
		...next[after.fingerprint],
		overallNote: old.overallNote,
		...(Object.keys(lineNotes).length ? { lineNotes } : {}),
		[after.source]: moved,
	}
	if (!lost) return next
	// The overall note and surviving line notes moved over; don't count them twice in the stale record.
	const stale = Object.fromEntries(Object.entries(old.lineNotes ?? {}).filter(([key]) => !(key in lineNotes)))
	next[before.fingerprint] = { ...old, overallNote: undefined, lineNotes: Object.keys(stale).length ? stale : undefined }
	if (!next[before.fingerprint].lineNotes) delete next[before.fingerprint].lineNotes
	return next
}

/** Notes the host will accept: only this document's stops and hunks, trimmed, non-empty. */
export function notesToSend(
	walk: ChangeWalkthrough,
	review: StopReview,
	overallNote: string | undefined,
	lineNotes: ReviewRecord["lineNotes"] = {},
) {
	const stopIds = new Set(allStops(walk).map((stop) => stop.id))
	const stopNotes = Object.fromEntries(
		Object.entries(review.notes)
			.map(([id, note]) => [id, note.trim()] as const)
			.filter(([id, note]) => note && stopIds.has(id)),
	)
	const hunks = new Map(walk.hunks.map((hunk) => [hunk.fingerprint, hunk]))
	const lines: WalkthroughLineNote[] = []
	for (const [key, value] of Object.entries(lineNotes)) {
		const { note, quote } = lineNoteEntry(value)
		const range = parseLineNoteKey(key)
		const hunk = range && hunks.get(range.fingerprint)
		if (!note.trim() || !range || !hunk) continue
		lines.push({
			hunkId: hunk.id,
			line: range.start,
			...(range.end > range.start ? { endLine: range.end } : {}),
			...(quote?.trim() ? { quote: quote.trim() } : {}),
			note: note.trim(),
		})
	}
	// In page order: by hunk, then line.
	const order = new Map(walk.hunks.map((hunk, index) => [hunk.id, index]))
	lines.sort((a, b) => (order.get(a.hunkId) ?? 0) - (order.get(b.hunkId) ?? 0) || a.line - b.line)
	const overall = overallNote?.trim()
	return {
		stopNotes,
		lineNotes: lines,
		overallNote: overall || undefined,
		count: Object.keys(stopNotes).length + lines.length + (overall ? 1 : 0),
	}
}
