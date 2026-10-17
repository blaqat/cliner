import type { QuoteDraft } from "../types/chatTypes"

/**
 * Builds the text sent for a draft with quotes: each quote as a markdown
 * blockquote followed by its note, then the typed message.
 */
export function formatMessageWithQuotes(text: string, quotes: readonly QuoteDraft[]): string {
	const parts = quotes.map((quote) => {
		const source = quote.source?.trim()
		const quoted = quote.text
			.trim()
			.split("\n")
			.map((line) => `> ${line}`)
			.join("\n")
		const attributed = source ? `> **${source}**\n${quoted}` : quoted
		const note = quote.note.trim()
		return note ? `${attributed}\n\n${note}` : attributed
	})
	const message = text.trim()
	if (message) {
		parts.push(message)
	}
	return parts.join("\n\n")
}

/**
 * The lines of an edited message that the user added or changed. A sent
 * message holds quote chips and walkthrough hunks as plain lines, so an edit
 * can only count text that differs from the original as typed by the user.
 */
export function addedLines(original: string, edited: string): string {
	const remaining = new Map<string, number>()
	for (const line of original.split("\n")) {
		remaining.set(line, (remaining.get(line) ?? 0) + 1)
	}
	return edited
		.split("\n")
		.filter((line) => {
			const count = remaining.get(line) ?? 0
			if (count > 0) {
				remaining.set(line, count - 1)
				return false
			}
			return true
		})
		.join("\n")
}
