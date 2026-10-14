export async function expandTaskNoteMentions(
	text: string,
	readNote: (slug: string) => Promise<{ name: string; content: string } | undefined>,
): Promise<string> {
	const pattern = /(?<![\w/#])#([a-z0-9]+(?:-[a-z0-9]+)*)(?![\w-])/g
	const notes = new Map<string, string>()
	for (const match of text.matchAll(pattern)) {
		const slug = match[1]
		if (notes.has(slug)) continue
		const note = await readNote(slug)
		if (!note) continue
		const name = note.name.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
		notes.set(slug, `<task_note name="${name}">\n${note.content}\n</task_note>`)
	}
	return text.replace(pattern, (match, slug: string) => notes.get(slug) ?? match)
}
