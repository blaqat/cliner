import { createHash } from "node:crypto"
import {
	type ChangeWalkthrough,
	hunkBodyLines,
	REVIEW_NOTES_PER_STOP,
	REVIEW_NOTES_TOTAL,
	type WalkthroughReview,
	type WalkthroughReviewNote,
} from "@shared/Walkthrough"

export const REVIEW_INSTRUCTIONS = `Include review ONLY when the user asked for review or improvement notes, for example "walkthrough this PR and note what could be improved". Use kind risk, suggestion, question or nice. Mark severity "high" only for real problems. Include at most 3 notes per stop and 10 total. Anchor with the stop's exact title and, for line notes, path and lines copied exactly from the patch. Omit stop for a whole-change note. Report only real concerns supported by the supplied diff or context; never invent or speculate about problems. No notes is a valid answer: return notes: [].`

export const reviewSchema = {
	type: "object" as const,
	additionalProperties: false,
	properties: {
		summary: { type: "string" as const, maxLength: 2000 },
		notes: {
			type: "array" as const,
			maxItems: REVIEW_NOTES_TOTAL,
			items: {
				type: "object" as const,
				additionalProperties: false,
				properties: {
					kind: { type: "string" as const, enum: ["risk", "suggestion", "question", "nice"] },
					severity: { type: "string" as const, enum: ["high"] },
					title: { type: "string" as const, maxLength: 200 },
					text: { type: "string" as const, maxLength: 4000 },
					stop: { type: "string" as const },
					path: { type: "string" as const },
					lines: { type: "string" as const },
				},
				required: ["kind", "title", "text"],
			},
		},
	},
	required: ["notes"],
}

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("review must contain objects")
	return value as Record<string, unknown>
}
function text(value: unknown, key: string, max: number): string {
	if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`Invalid review.${key}`)
	return value.trim()
}

/** Resolve exact text against live hunks. Missing anchors retain the note at the nearest known scope. */
export function parseReview(
	value: unknown,
	walk: Pick<ChangeWalkthrough, "chapters" | "support" | "hunks">,
): WalkthroughReview | undefined {
	if (value === undefined) return undefined
	const raw = object(value)
	if (!Array.isArray(raw.notes)) throw new Error("review.notes must be an array")
	const stops = [...walk.chapters.flatMap((chapter) => chapter.stops), ...walk.support]
	const candidates = raw.notes.map((entry): WalkthroughReviewNote => {
		const note = object(entry)
		if (!["risk", "suggestion", "question", "nice"].includes(note.kind as string)) throw new Error("Invalid review.kind")
		if (note.severity !== undefined && note.severity !== "high") throw new Error("Invalid review.severity")
		for (const key of ["stop", "path", "lines"])
			if (note[key] !== undefined) text(note[key], key, key === "lines" ? 16000 : 2000)
		let stop = stops.find((stop) => stop.title === note.stop)
		const result: WalkthroughReviewNote = {
			id: "",
			kind: note.kind as WalkthroughReviewNote["kind"],
			title: text(note.title, "title", 200),
			text: text(note.text, "text", 4000),
			...(note.severity === "high" ? { severity: "high" as const } : {}),
		}
		if (typeof note.path === "string" && typeof note.lines === "string") {
			const quoted = note.lines.trim().split("\n")
			for (const hunk of walk.hunks.filter(
				(h) => h.path === note.path && !h.synthetic && (!stop || stop.hunkIds.includes(h.id)),
			)) {
				const body = hunkBodyLines(hunk.patch)
				const matches = body.flatMap((_, i) =>
					quoted.every((line, j) => {
						const actual = body[i + j]?.slice(1).trim()
						return actual !== undefined && (actual === line.trim() || actual === line.replace(/^[ +-]/, "").trim())
					})
						? [i]
						: [],
				)
				const line = matches.find((i) => /^[+-]/.test(body[i])) ?? matches[0]
				if (line === undefined) continue
				result.hunkId = hunk.id
				result.line = line
				if (quoted.length > 1) result.endLine = line + quoted.length - 1
				stop ??= stops.find((s) => s.hunkIds.includes(hunk.id))
				break
			}
		}
		if (stop) result.stopId = stop.id
		result.id = `r-${createHash("sha256")
			.update(JSON.stringify({ ...result, id: undefined }))
			.digest("hex")
			.slice(0, 24)}`
		return result
	})
	const counts = new Map<string, number>()
	const ids = new Set<string>()
	const notes = candidates
		.sort((a, b) => Number(b.severity === "high") - Number(a.severity === "high"))
		.filter((note) => {
			if (ids.has(note.id) || ids.size >= REVIEW_NOTES_TOTAL) return false
			if (note.stopId && (counts.get(note.stopId) ?? 0) >= REVIEW_NOTES_PER_STOP) return false
			ids.add(note.id)
			if (note.stopId) counts.set(note.stopId, (counts.get(note.stopId) ?? 0) + 1)
			return true
		})
	return { ...(raw.summary !== undefined ? { summary: text(raw.summary, "summary", 2000) } : {}), notes }
}
