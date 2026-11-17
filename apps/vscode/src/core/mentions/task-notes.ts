export interface TaskNoteMentionNote {
	name: string
	content: string
	/**
	 * Title of the note's task when it lives outside the conversation's own
	 * task — emitted as a `task` attribute on the `<task_note>` tag.
	 */
	taskTitle?: string
}

export type TaskNoteReader = (slug: string, groupQualifier?: string) => Promise<TaskNoteMentionNote | undefined>

function escapeAttr(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

/**
 * Replaces `#slug` and cross-task `#<group>/<slug>` mentions with the note's
 * content. The optional `<group>` part is a task group's id or its slugified
 * title; the reader decides where to look (current task first). Mentions that
 * resolve to nothing are left untouched.
 */
export async function expandTaskNoteMentions(text: string, readNote: TaskNoteReader): Promise<string> {
	const pattern = /(?<![\w/#])#(?:([a-z0-9][a-z0-9_-]*)\/)?([a-z0-9]+(?:-[a-z0-9]+)*)(?![\w/-])/g
	const notes = new Map<string, string>()
	for (const match of text.matchAll(pattern)) {
		const key = match[0]
		if (notes.has(key)) continue
		const qualifier = match[1]
		const slug = match[2]
		const note = await readNote(slug, qualifier)
		if (!note) continue
		const task = note.taskTitle ? ` task="${escapeAttr(note.taskTitle)}"` : ""
		notes.set(key, `<task_note name="${escapeAttr(note.name)}"${task}>\n${note.content}\n</task_note>`)
	}
	return text.replace(pattern, (match) => notes.get(match) ?? match)
}
