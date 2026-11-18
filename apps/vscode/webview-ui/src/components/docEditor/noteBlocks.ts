import type { NotebookDiffLine } from "@shared/task-groups"
import { marked } from "marked"

/** Zero-based line numbers of the new text that the diff adds. */
export function addedLineNumbers(diff: NotebookDiffLine[]): Set<number> {
	const added = new Set<number>()
	let line = 0
	for (const entry of diff) {
		if (entry.kind === "remove") continue
		if (entry.kind === "add") added.add(line)
		line += entry.kind === "collapsed" ? entry.text.split("\n").length : 1
	}
	return added
}

/** Counts for a review chip: lines added and removed. */
export function diffCounts(diff: NotebookDiffLine[]): { added: number; removed: number } {
	let added = 0
	let removed = 0
	for (const entry of diff) {
		if (entry.kind === "add" && entry.text.trim()) added++
		if (entry.kind === "remove" && entry.text.trim()) removed++
	}
	return { added, removed }
}

/** The heading the first added line sits under ("in Gotchas"), if any. */
export function changedSection(content: string, diff: NotebookDiffLine[]): string | undefined {
	const first = Math.min(...addedLineNumbers(diff))
	if (!Number.isFinite(first)) return undefined
	const lines = content.split("\n")
	for (let i = Math.min(first, lines.length - 1); i >= 0; i--) {
		const heading = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(lines[i])
		if (heading) return heading[1]
	}
	return undefined
}

export interface NoteBlock {
	/** Markdown source of the block (a paragraph, heading, code block or one list item). */
	raw: string
	marked: boolean
	heading?: string
	lines: number
}

function newlines(text: string): number {
	return text.split("\n").length - 1
}

/**
 * Splits a note into rendered blocks (list items one by one, so a single new
 * bullet is marked rather than its whole list) and marks those holding an
 * added line.
 */
export function noteBlocks(content: string, added: Set<number>): NoteBlock[] {
	let tokens: ReturnType<typeof marked.lexer>
	try {
		tokens = marked.lexer(content)
	} catch {
		return [{ raw: content, marked: added.size > 0, lines: newlines(content) + 1 }]
	}
	const blocks: NoteBlock[] = []
	let line = 0
	const push = (raw: string, heading?: string) => {
		const body = raw.replace(/\n+$/, "")
		const span = newlines(body)
		let isMarked = false
		for (let i = line; i <= line + span; i++) if (added.has(i)) isMarked = true
		if (body.trim()) blocks.push({ raw: body, marked: isMarked, heading, lines: span + 1 })
		line += newlines(raw)
	}
	for (const token of tokens) {
		if (token.type === "list" && Array.isArray((token as { items?: { raw: string }[] }).items)) {
			const items = (token as { items: { raw: string }[] }).items
			const joined = items.map((item) => item.raw).join("")
			if (joined === token.raw.slice(0, joined.length)) {
				for (const item of items) push(item.raw)
				line += newlines(token.raw.slice(joined.length))
				continue
			}
		}
		push(token.raw, token.type === "heading" ? (token as { text: string }).text : undefined)
	}
	return blocks
}

export interface NoteSection {
	heading?: string
	blocks: NoteBlock[]
	marked: boolean
	lines: number
}

/** Groups blocks under their headings, for folding the untouched parts of a long note. */
export function noteSections(blocks: NoteBlock[]): NoteSection[] {
	const sections: NoteSection[] = []
	for (const block of blocks) {
		if (block.heading !== undefined || !sections.length) {
			sections.push({ heading: block.heading, blocks: [], marked: false, lines: 0 })
		}
		const section = sections[sections.length - 1]
		section.blocks.push(block)
		section.marked ||= block.marked
		section.lines += block.lines
	}
	return sections
}
