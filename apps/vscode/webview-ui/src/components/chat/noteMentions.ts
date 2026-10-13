import { GetTaskGroupRequest } from "@shared/proto/cline/task_group"
import type { NotebookNoteMeta } from "@shared/task-groups"
import { useEffect, useState } from "react"
import { TaskGroupServiceClient } from "@/services/grpc-client"

export type NoteMentionOption = Pick<NotebookNoteMeta, "slug" | "name" | "description">

/** Most notes the `#` menu lists at once. */
export const NOTE_MENTION_LIMIT = 8

// Same boundary as the extension's expansion (core/mentions/task-notes.ts): a `#`
// that starts a word, not one inside `a#b`, a path, or `##`.
const MENTION_BEFORE_CURSOR = /(^|[^\w/#])#([\w-]*)$/

/** The `#query` the cursor is in, with the index of its `#`; undefined when not in one. */
export function findNoteMention(text: string, cursor: number): { start: number; query: string } | undefined {
	const match = MENTION_BEFORE_CURSOR.exec(text.slice(0, cursor))
	if (!match) return undefined
	return { start: match.index + match[1].length, query: match[2] }
}

/** Notes whose slug or name contains the query, slug-prefix matches first. */
export function matchNotes(notes: readonly NoteMentionOption[], query: string): NoteMentionOption[] {
	const q = query.toLowerCase()
	return notes
		.filter((note) => !q || note.slug.includes(q) || note.name.toLowerCase().includes(q))
		.sort((a, b) => Number(b.slug.startsWith(q)) - Number(a.slug.startsWith(q)))
		.slice(0, NOTE_MENTION_LIMIT)
}

/** Replaces the `#query` ending at `cursor` with `#<slug> `. */
export function insertNoteMention(text: string, cursor: number, start: number, slug: string): { value: string; cursor: number } {
	const inserted = `#${slug} `
	const rest = text.slice(cursor).replace(/^ /, "")
	return { value: text.slice(0, start) + inserted + rest, cursor: start + inserted.length }
}

// Per group, keyed with its note count so a new note invalidates the entry.
const noteCache = new Map<string, Promise<NoteMentionOption[]>>()

function fetchNotes(taskGroupId: string, version: number | undefined): Promise<NoteMentionOption[]> {
	const key = `${taskGroupId}:${version ?? ""}`
	let notes = noteCache.get(key)
	if (!notes) {
		notes = TaskGroupServiceClient.getTaskGroup(GetTaskGroupRequest.create({ id: taskGroupId })).then(
			(response) => response.notes.map((note) => ({ slug: note.slug, name: note.name, description: note.description })),
			(error) => {
				console.error("Failed to load task notes:", error)
				noteCache.delete(key)
				return []
			},
		)
		noteCache.set(key, notes)
	}
	return notes
}

export function clearNoteMentionCache(): void {
	noteCache.clear()
}

/** The task's notes for the `#` menu, fetched once per group (and note count) when first needed. */
export function useTaskNotes(taskGroupId: string | undefined, version?: number): NoteMentionOption[] {
	const [loaded, setLoaded] = useState<{ id: string; notes: NoteMentionOption[] }>()
	useEffect(() => {
		if (!taskGroupId) return
		let cancelled = false
		fetchNotes(taskGroupId, version).then((notes) => {
			if (!cancelled) setLoaded({ id: taskGroupId, notes })
		})
		return () => {
			cancelled = true
		}
	}, [taskGroupId, version])
	return taskGroupId && loaded?.id === taskGroupId ? loaded.notes : []
}
