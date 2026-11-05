import {
	type ChangeWalkthrough,
	hunkBodyLines,
	hunkLineNumbers,
	type WalkthroughReviewKind,
	type WalkthroughReviewNote,
	type WalkthroughReviewResponse,
	type WalkthroughStop,
} from "@shared/Walkthrough"

/** How each kind reads: its label and codicon. Only Risk takes a color (the warning one). */
export const REVIEW_KINDS: Record<WalkthroughReviewKind, { label: string; plural: string; icon: string; tone?: string }> = {
	risk: { label: "Risk", plural: "risks", icon: "warning", tone: "text-warning" },
	suggestion: { label: "Suggestion", plural: "suggestions", icon: "lightbulb" },
	question: { label: "Question", plural: "questions", icon: "question" },
	nice: { label: "Nice", plural: "nice things", icon: "thumbsup" },
}

/** Filter and legend order. */
export const KIND_ORDER: WalkthroughReviewKind[] = ["risk", "question", "suggestion", "nice"]

/** Notes per stop group before "+N more". */
export const TOP_NOTES = 3

/**
 * A note where the page shows it. Line notes keep their hunk and lines when the lines exist;
 * otherwise they fall back to their stop (or the whole change) with `lineLost`.
 */
export interface PlacedReviewNote {
	note: WalkthroughReviewNote
	/** Absent for a note on the whole change. */
	stopId?: string
	hunkId?: string
	line?: number
	endLine?: number
	/** The note pointed at a line (or stop) this diff doesn't have. */
	lineLost?: boolean
}

const allStops = (walk: ChangeWalkthrough): WalkthroughStop[] => [
	...walk.chapters.flatMap((chapter) => chapter.stops),
	...walk.support,
]

/** Places every review note on the whole change, a stop, or lines that really exist. */
export function placeReviewNotes(walk: ChangeWalkthrough | undefined): PlacedReviewNote[] {
	const notes = walk?.review?.notes ?? []
	if (!walk || !notes.length) return []
	const stops = allStops(walk)
	const hunks = new Map(walk.hunks.map((hunk) => [hunk.id, hunk]))
	return notes.map((note) => {
		const named = note.stopId ? stops.find((stop) => stop.id === note.stopId) : undefined
		const wantsLines = note.hunkId !== undefined || note.line !== undefined
		const hunk = note.hunkId ? hunks.get(note.hunkId) : undefined
		// A line note without a stop belongs to the stop that shows its hunk.
		const stop = named ?? (hunk ? stops.find((candidate) => candidate.hunkIds.includes(hunk.id)) : undefined)
		const lost = (!!note.stopId && !named) || undefined
		if (!wantsLines) return { note, stopId: stop?.id, lineLost: lost }
		const length = hunk && !hunk.synthetic ? hunkBodyLines(hunk.patch).length : 0
		const line = note.line ?? 0
		const fits = !!stop?.hunkIds.includes(hunk?.id ?? "") && Number.isInteger(line) && line >= 0 && line < length
		if (!fits || !hunk) return { note, stopId: stop?.id, lineLost: true }
		const end = note.endLine !== undefined && note.endLine > line ? Math.min(note.endLine, length - 1) : undefined
		return { note, stopId: stop?.id, hunkId: hunk.id, line, ...(end !== undefined ? { endLine: end } : {}) }
	})
}

const KIND_RANK: Record<WalkthroughReviewKind, number> = { risk: 0, question: 1, suggestion: 2, nice: 3 }

/** High severity first, then by kind; otherwise Cline's order. */
export const sortReviewNotes = (list: PlacedReviewNote[]) =>
	[...list].sort(
		(a, b) =>
			(b.note.severity === "high" ? 1 : 0) - (a.note.severity === "high" ? 1 : 0) ||
			KIND_RANK[a.note.kind] - KIND_RANK[b.note.kind],
	)

export interface ReviewGroup {
	/** "whole" or the stop id. */
	key: string
	stop?: WalkthroughStop
	/** 1-based for main stops. */
	number?: number
	notes: PlacedReviewNote[]
}

/** Whole-change notes first, then each stop in page order; empty groups are left out. */
export function groupReviewNotes(walk: ChangeWalkthrough, placed: PlacedReviewNote[]): ReviewGroup[] {
	const main = walk.chapters.flatMap((chapter) => chapter.stops)
	const groups: ReviewGroup[] = [{ key: "whole", notes: sortReviewNotes(placed.filter((p) => !p.stopId)) }]
	for (const [index, stop] of [...main, ...walk.support].entries()) {
		groups.push({
			key: stop.id,
			stop,
			number: index < main.length ? index + 1 : undefined,
			notes: sortReviewNotes(placed.filter((p) => p.stopId === stop.id)),
		})
	}
	return groups.filter((group) => group.notes.length > 0)
}

/** One group as the panel shows it: up to three that matter most, the rest behind "+N more", nice notes folded. */
export function splitGroup(notes: PlacedReviewNote[]) {
	const nice = notes.filter((p) => p.note.kind === "nice")
	const others = notes.filter((p) => p.note.kind !== "nice")
	return { top: others.slice(0, TOP_NOTES), more: others.slice(TOP_NOTES), nice }
}

/** "2 questions, 1 suggestion": what "+N more" holds. */
export function describeKinds(notes: PlacedReviewNote[]): string {
	return KIND_ORDER.flatMap((kind) => {
		const count = notes.filter((p) => p.note.kind === kind).length
		if (!count) return []
		const { label, plural } = REVIEW_KINDS[kind]
		return [`${count} ${count === 1 ? label.toLowerCase() : plural}`]
	}).join(", ")
}

/** "line 48", "lines 48–49" or "old line 12", in the file's numbers. */
export function reviewLineLabel(walk: ChangeWalkthrough, placed: PlacedReviewNote): string | undefined {
	const hunk = placed.hunkId ? walk.hunks.find((h) => h.id === placed.hunkId) : undefined
	if (!hunk || placed.line === undefined) return undefined
	const numbers = hunkLineNumbers(hunk)
	const body = hunkBodyLines(hunk.patch)
	const end = placed.endLine ?? placed.line
	const old = body.slice(placed.line, end + 1).every((line) => line.startsWith("-")) ? "old " : ""
	const first = numbers[placed.line]
	const last = numbers[end]
	return end > placed.line && first !== last ? `${old}lines ${first}–${last}` : `${old}line ${first}`
}

/** A note still waiting on the reviewer: not dismissed. */
export const isOpen = (response: WalkthroughReviewResponse | undefined) => !response?.dismissed

/** What a response sends: a fix request, a reply, or nothing (dismissed or left alone). */
export function responseToSend(response: WalkthroughReviewResponse | undefined): WalkthroughReviewResponse | undefined {
	if (!response || response.dismissed) return undefined
	const reply = response.reply?.trim()
	if (!response.fix && !reply) return undefined
	return { ...(response.fix ? { fix: true } : {}), ...(reply ? { reply } : {}) }
}

/** Kinds the reviewer turned off; `all` hides every one of Cline's notes, markers and panel alike. */
export interface ReviewFilter {
	hidden: Partial<Record<WalkthroughReviewKind, boolean>>
	all: boolean
}

export const EMPTY_REVIEW_FILTER: ReviewFilter = { hidden: {}, all: false }

export const shownByFilter = (filter: ReviewFilter, placed: PlacedReviewNote) => !filter.all && !filter.hidden[placed.note.kind]
