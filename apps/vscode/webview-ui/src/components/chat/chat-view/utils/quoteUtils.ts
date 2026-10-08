import type { QuoteDraft } from "../types/chatTypes"

/**
 * Builds the text sent for a draft with quotes: each quote as a markdown
 * blockquote followed by its note, then the typed message.
 */
export function formatMessageWithQuotes(text: string, quotes: readonly QuoteDraft[]): string {
	const parts = quotes.map((quote) => {
		const quoted = quote.text
			.trim()
			.split("\n")
			.map((line) => `> ${line}`)
			.join("\n")
		const note = quote.note.trim()
		return note ? `${quoted}\n\n${note}` : quoted
	})
	const message = text.trim()
	if (message) {
		parts.push(message)
	}
	return parts.join("\n\n")
}
