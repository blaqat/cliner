import type { NotebookDiffLine } from "@shared/task-groups"

/** A piece of a changed line; `changed` pieces are what the edit actually touched. */
export interface WordPart {
	text: string
	changed: boolean
}

// Past this many token pairs, highlighting the whole line is cheaper than comparing words.
const MAX_CELLS = 60_000

const tokens = (text: string) => text.match(/\s+|\w+|[^\s\w]/g) ?? []

function merge(parts: WordPart[]): WordPart[] {
	const merged: WordPart[] = []
	for (const part of parts) {
		const last = merged.at(-1)
		if (last && last.changed === part.changed) last.text += part.text
		else merged.push({ ...part })
	}
	return merged
}

/**
 * The words that differ between a removed line and the line that replaced it, so a
 * one-word edit in a long paragraph stands out. `undefined` when the lines are too
 * long to compare or share nothing (the whole line is the change then).
 */
export function wordDiff(before: string, after: string): { before: WordPart[]; after: WordPart[] } | undefined {
	const a = tokens(before)
	const b = tokens(after)
	if (!a.length || !b.length || a.length * b.length > MAX_CELLS) return undefined
	// Longest common subsequence over tokens, filled from the end.
	const width = b.length + 1
	const table = new Uint16Array((a.length + 1) * width)
	for (let i = a.length - 1; i >= 0; i--) {
		for (let j = b.length - 1; j >= 0; j--) {
			table[i * width + j] =
				a[i] === b[j]
					? table[(i + 1) * width + j + 1] + 1
					: Math.max(table[(i + 1) * width + j], table[i * width + j + 1])
		}
	}
	const left: WordPart[] = []
	const right: WordPart[] = []
	let shared = 0
	let i = 0
	let j = 0
	while (i < a.length || j < b.length) {
		if (i < a.length && j < b.length && a[i] === b[j]) {
			// Whitespace alone in common isn't a shared line.
			if (/\S/.test(a[i])) shared++
			left.push({ text: a[i++], changed: false })
			right.push({ text: b[j++], changed: false })
		} else if (j < b.length && (i === a.length || table[i * width + j + 1] >= table[(i + 1) * width + j])) {
			right.push({ text: b[j++], changed: true })
		} else {
			left.push({ text: a[i++], changed: true })
		}
	}
	if (shared === 0) return undefined
	return { before: merge(left), after: merge(right) }
}

/**
 * Pairs each removed line with the added line that replaced it (in order, within one
 * hunk), keyed by their index in `lines`, with the words that changed.
 */
export function pairChangedLines(lines: readonly NotebookDiffLine[]): Map<number, WordPart[]> {
	const parts = new Map<number, WordPart[]>()
	let index = 0
	while (index < lines.length) {
		if (lines[index].kind !== "remove") {
			index++
			continue
		}
		const removed: number[] = []
		while (lines[index]?.kind === "remove") removed.push(index++)
		const added: number[] = []
		while (lines[index]?.kind === "add") added.push(index++)
		for (let k = 0; k < Math.min(removed.length, added.length); k++) {
			const diff = wordDiff(lines[removed[k]].text, lines[added[k]].text)
			if (!diff) continue
			parts.set(removed[k], diff.before)
			parts.set(added[k], diff.after)
		}
	}
	return parts
}
