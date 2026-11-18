/** A textarea edit: the new text and where the selection lands. */
export interface TextEdit {
	text: string
	start: number
	end: number
}

/**
 * Wraps the selection in `before`/`after` (bold, italic, code, link). With an
 * empty selection it inserts the markers around `placeholder` and selects it;
 * when the selection is already wrapped, it unwraps.
 */
export function wrapSelection(
	text: string,
	start: number,
	end: number,
	before: string,
	after = before,
	placeholder = "text",
): TextEdit {
	const selected = text.slice(start, end)
	if (
		text.slice(start - before.length, start) === before &&
		text.slice(end, end + after.length) === after &&
		(selected || before !== after)
	) {
		return {
			text: text.slice(0, start - before.length) + selected + text.slice(end + after.length),
			start: start - before.length,
			end: end - before.length,
		}
	}
	const inner = selected || placeholder
	return {
		text: text.slice(0, start) + before + inner + after + text.slice(end),
		start: start + before.length,
		end: start + before.length + inner.length,
	}
}

/** The start of the line holding `index`. */
function lineStart(text: string, index: number): number {
	return text.lastIndexOf("\n", index - 1) + 1
}

/**
 * Prefixes every line the selection touches (`# `, `- `, `1. `, `- [ ] `).
 * Lines that all carry the prefix already lose it instead, so it toggles.
 * Numbered lists count up from 1.
 */
export function prefixLines(text: string, start: number, end: number, prefix: string): TextEdit {
	const from = lineStart(text, start)
	const lineEnd = text.indexOf("\n", Math.max(end - (end > start && text[end - 1] === "\n" ? 1 : 0), from))
	const to = lineEnd === -1 ? text.length : lineEnd
	const lines = text.slice(from, to).split("\n")
	const numbered = prefix === "1. "
	const pattern = numbered ? /^\d+\. / : new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
	const remove = lines.every((line) => pattern.test(line))
	const next = lines.map((line, index) =>
		remove ? line.replace(pattern, "") : `${numbered ? `${index + 1}. ` : prefix}${line}`,
	)
	const replaced = next.join("\n")
	const delta = replaced.length - (to - from)
	const firstDelta = next[0].length - lines[0].length
	return {
		text: text.slice(0, from) + replaced + text.slice(to),
		start: Math.max(from, start + firstDelta),
		end: end + delta,
	}
}

/** Inserts a fenced code block around the selection (or an empty one) on its own lines. */
export function codeBlock(text: string, start: number, end: number): TextEdit {
	const selected = text.slice(start, end)
	const lead = start > 0 && text[start - 1] !== "\n" ? "\n" : ""
	const block = `${lead}\`\`\`\n${selected}\n\`\`\`\n`
	const caret = start + lead.length + 4
	return {
		text: text.slice(0, start) + block + text.slice(end),
		start: caret,
		end: caret + selected.length,
	}
}

export type FormatAction = "bold" | "italic" | "code" | "link" | "heading" | "bullet" | "numbered" | "task" | "codeblock"

export function applyFormat(action: FormatAction, text: string, start: number, end: number): TextEdit {
	switch (action) {
		case "bold":
			return wrapSelection(text, start, end, "**")
		case "italic":
			return wrapSelection(text, start, end, "_")
		case "code":
			return wrapSelection(text, start, end, "`", "`", "code")
		case "link": {
			const edit = wrapSelection(text, start, end, "[", "](url)", "link text")
			// Select the url placeholder when the text was already there, so typing replaces it.
			return start === end ? edit : { ...edit, start: edit.end + 2, end: edit.end + 5 }
		}
		case "heading":
			return prefixLines(text, start, end, "## ")
		case "bullet":
			return prefixLines(text, start, end, "- ")
		case "numbered":
			return prefixLines(text, start, end, "1. ")
		case "task":
			return prefixLines(text, start, end, "- [ ] ")
		case "codeblock":
			return codeBlock(text, start, end)
	}
}

/**
 * Enter at the end of a list item continues the list; Enter on an empty item
 * ends it. Returns undefined when Enter should behave normally.
 */
export function continueList(text: string, caret: number): TextEdit | undefined {
	const from = lineStart(text, caret)
	const line = text.slice(from, caret)
	const match = /^(\s*)(- \[[ xX]\] |[-*+] |(\d+)\. )/.exec(line)
	if (!match) return undefined
	if (line.length === match[0].length) {
		// An empty item: Enter ends the list.
		return { text: text.slice(0, from) + text.slice(caret), start: from, end: from }
	}
	const marker = match[3] ? `${Number(match[3]) + 1}. ` : match[2].startsWith("- [") ? "- [ ] " : match[2]
	const insert = `\n${match[1]}${marker}`
	return { text: text.slice(0, caret) + insert + text.slice(caret), start: caret + insert.length, end: caret + insert.length }
}
