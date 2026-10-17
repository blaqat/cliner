import type { ChangeWalkthrough, WalkthroughScope } from "@shared/Walkthrough"

/** Notes and reviewed marks for one walkthrough layout. Stop ids are only stable within a source. */
export interface StopReview {
	notes: Record<string, string>
	reviewed: Record<string, boolean>
}

export interface ReviewRecord {
	overallNote?: string
	fallback?: StopReview
	generated?: StopReview
}

/** Records per diff fingerprint. Usually one; a second means the changes moved and the old one awaits a refresh. */
export type ReviewStore = Record<string, ReviewRecord>

const KEY_PREFIX = "cline.walkthroughReview"

export const reviewStorageKey = (taskId: string, scope: WalkthroughScope) => `${KEY_PREFIX}:${taskId}:${scope}`

export const EMPTY_STOP_REVIEW: StopReview = { notes: {}, reviewed: {} }

export function loadReviewStore(taskId: string, scope: WalkthroughScope): ReviewStore {
	try {
		const parsed: unknown = JSON.parse(localStorage.getItem(reviewStorageKey(taskId, scope)) ?? "{}")
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as ReviewStore) : {}
	} catch {
		return {}
	}
}

export function saveReviewStore(taskId: string, scope: WalkthroughScope, store: ReviewStore) {
	try {
		const key = reviewStorageKey(taskId, scope)
		const kept = Object.fromEntries(Object.entries(store).filter(([, record]) => hasContent(record)))
		if (Object.keys(kept).length) localStorage.setItem(key, JSON.stringify(kept))
		else localStorage.removeItem(key)
	} catch {
		// Storage full or unavailable: review state just won't survive a reload.
	}
}

const filled = (notes: Record<string, string> = {}) => Object.values(notes).filter((note) => note.trim()).length
const marked = (reviewed: Record<string, boolean> = {}) => Object.values(reviewed).filter(Boolean).length

export function hasContent(record: ReviewRecord | undefined): boolean {
	if (!record) return false
	return (
		!!record.overallNote?.trim() ||
		[record.fallback, record.generated].some((review) => filled(review?.notes) + marked(review?.reviewed) > 0)
	)
}

/** What a moved-away fingerprint still holds, for the "Changes moved" banner. */
export function summarizeStale(store: ReviewStore, fingerprint: string): { notes: number; reviewed: number } {
	let notes = 0
	let reviewed = 0
	for (const [key, record] of Object.entries(store)) {
		if (key === fingerprint || !hasContent(record)) continue
		notes += (record.overallNote?.trim() ? 1 : 0) + filled(record.fallback?.notes) + filled(record.generated?.notes)
		reviewed += marked(record.fallback?.reviewed) + marked(record.generated?.reviewed)
	}
	return { notes, reviewed }
}

/** Keeps only the current fingerprint's record: what Refresh does once the user accepts the new changes. */
export function dropStale(store: ReviewStore, fingerprint: string): ReviewStore {
	return store[fingerprint] ? { [fingerprint]: store[fingerprint] } : {}
}

export function stopReviewFor(store: ReviewStore, walk: ChangeWalkthrough): StopReview {
	return store[walk.fingerprint]?.[walk.source] ?? EMPTY_STOP_REVIEW
}

const allStops = (walk: ChangeWalkthrough) => [...walk.chapters.flatMap((chapter) => chapter.stops), ...walk.support]

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
	const next: ReviewStore = { ...store }
	if (!lost) delete next[before.fingerprint]
	next[after.fingerprint] = { ...next[after.fingerprint], overallNote: old.overallNote, [after.source]: moved }
	if (!lost) return next
	// The overall note moved over; don't count it twice in the stale record.
	next[before.fingerprint] = { ...old, overallNote: undefined }
	return next
}

/** Notes the host will accept: only this document's stops, trimmed, non-empty. */
export function notesToSend(walk: ChangeWalkthrough, review: StopReview, overallNote: string | undefined) {
	const stopIds = new Set(allStops(walk).map((stop) => stop.id))
	const stopNotes = Object.fromEntries(
		Object.entries(review.notes)
			.map(([id, note]) => [id, note.trim()] as const)
			.filter(([id, note]) => note && stopIds.has(id)),
	)
	const overall = overallNote?.trim()
	return { stopNotes, overallNote: overall || undefined, count: Object.keys(stopNotes).length + (overall ? 1 : 0) }
}
