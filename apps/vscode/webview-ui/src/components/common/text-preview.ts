// Bound work before Markdown parsing, highlighting, patch parsing, and DOM creation.
// Character limits also cover minified files and single multi-megabyte lines.
export const TEXT_PREVIEW_CHARACTERS = 16 * 1024
export const TEXT_PREVIEW_LINES = 200

export function getTextPreview(source: string, start = 0): { text: string; end: number; truncated: boolean } {
	let end = Math.min(source.length, start + TEXT_PREVIEW_CHARACTERS)
	let lines = 0
	for (let i = start; i < end; i++) {
		if (source.charCodeAt(i) === 10 && ++lines === TEXT_PREVIEW_LINES) {
			end = i + 1
			break
		}
	}
	// Do not split a UTF-16 surrogate pair between pages.
	if (end < source.length && source.charCodeAt(end - 1) >= 0xd800 && source.charCodeAt(end - 1) <= 0xdbff) end--
	return { text: source.slice(start, end), end, truncated: end < source.length }
}
