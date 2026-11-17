import type { ChangeWalkthrough } from "../../src/shared/Walkthrough"
import { ceilings } from "../../src/services/walkthrough/engine"

/** Deterministic 0–100 judge. Raw structural mistakes remain visible before repair. */
export function scoreWalkthrough(walk: ChangeWalkthrough, expectedConcepts: string[] = []) {
	const stops = walk.chapters.flatMap((chapter) => chapter.stops)
	const ids = [...stops, ...walk.support].flatMap((stop) => stop.hunkIds)
	const known = new Set(walk.hunks.map((hunk) => hunk.id))
	const seen = new Set(ids)
	const problems: string[] = []
	if (ids.some((id) => !known.has(id))) problems.push("unknown aliases")
	if (seen.size !== ids.length) problems.push("duplicate aliases")
	if ([...known].some((id) => !seen.has(id))) problems.push("missing coverage")
	const limits = ceilings(walk.hunks)
	if (stops.length > limits.stops || walk.chapters.length > limits.chapters) problems.push("size ceiling")
	if (stops.some((stop) => stop.hunkIds.length > 14)) problems.push("oversized stop")
	if (walk.chapters.some((chapter) => chapter.title.length > 16)) problems.push("long chapter title")
	if (!stops.length && walk.hunks.length) problems.push("no review path")
	if (
		stops.some(
			(stop) =>
				/[\\/]|\.[a-z]{1,4}$/i.test(stop.title) ||
				stop.title.split(/\s+/).length < 2 ||
				stop.title.split(/\s+/).length > 6,
		)
	)
		problems.push("non-semantic stop title")
	const prose = [walk.title, walk.focus, ...stops.map((s) => `${s.title} ${s.prose}`)].join(" ").toLowerCase()
	if (/\b(appears|likely|seems|robust|seamless)\b/.test(prose)) problems.push("filler or hedging")
	const concepts = expectedConcepts.filter((concept) => prose.includes(concept.toLowerCase()))
	const structure = Math.max(0, 70 - problems.length * 10)
	const content = expectedConcepts.length ? Math.round((30 * concepts.length) / expectedConcepts.length) : 30
	return { score: structure + content, structure, content, problems, concepts, expectedConcepts }
}
