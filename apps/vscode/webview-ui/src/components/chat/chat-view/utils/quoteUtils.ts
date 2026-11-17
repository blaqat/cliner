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
