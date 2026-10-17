import { EmptyRequest } from "@shared/proto/cline/common"
import type { TaskGroupNotes } from "@shared/proto/cline/task_group"
import type { NotebookNoteMeta, TaskGroupSummary } from "@shared/task-groups"
import { useEffect, useMemo, useState } from "react"
import { TaskGroupServiceClient } from "@/services/grpc-client"

export interface NoteMentionOption extends Pick<NotebookNoteMeta, "slug" | "name" | "description"> {
	/** Owning task group — notes carry the group so cross-task picks stay unambiguous. */
	taskGroupId?: string
	taskGroupTitle?: string
	/** True for notes in the composer's own task; they rank first and insert bare `#slug`. */
	isCurrentTask?: boolean
	/** Text inserted into the composer: `#slug` in the current task, `#<group>/<slug>` elsewhere. */
	insertText?: string
}

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

/**
 * Notes whose slug or name contains the query, slug-prefix matches first —
 * with the composer's own task's notes always ranked above other tasks'.
 */
export function matchNotes(notes: readonly NoteMentionOption[], query: string): NoteMentionOption[] {
	const q = query.toLowerCase()
	return notes
		.filter((note) => !q || note.slug.includes(q) || note.name.toLowerCase().includes(q))
		.sort(
			(a, b) =>
				Number(b.isCurrentTask ?? false) - Number(a.isCurrentTask ?? false) ||
				Number(b.slug.startsWith(q)) - Number(a.slug.startsWith(q)),
		)
		.slice(0, NOTE_MENTION_LIMIT)
}

/** Replaces the `#query` ending at `cursor` with the given mention text plus a space. */
export function insertNoteMention(
	text: string,
	cursor: number,
	start: number,
	mention: string,
): { value: string; cursor: number } {
	const inserted = `${mention} `
	const rest = text.slice(cursor).replace(/^ /, "")
	return { value: text.slice(0, start) + inserted + rest, cursor: start + inserted.length }
}

function slugifyGroupTitle(title: string): string {
	return title
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
}

/** Flattens per-group note lists into menu options, marking the composer's own task. */
export function groupNotesToOptions(
	groups: readonly TaskGroupNotes[],
	currentTaskGroupId: string | undefined | null,
): NoteMentionOption[] {
	const options: NoteMentionOption[] = []
	for (const group of groups) {
		const isCurrentTask = group.taskGroupId === currentTaskGroupId
		const groupSlug = slugifyGroupTitle(group.taskGroupTitle) || group.taskGroupId
		for (const note of group.notes) {
			options.push({
				slug: note.slug,
				name: note.name,
				description: note.description,
				taskGroupId: group.taskGroupId,
				taskGroupTitle: group.taskGroupTitle,
				isCurrentTask,
				insertText: isCurrentTask ? `#${note.slug}` : `#${groupSlug}/${note.slug}`,
			})
		}
	}
	return options
}

// Notes across all tasks, keyed on the task-group list's note counts so a new
// note anywhere invalidates the cached entry.
const allNotesCache = new Map<string, Promise<TaskGroupNotes[]>>()

function fetchAllNotes(versionKey: string): Promise<TaskGroupNotes[]> {
	let notes = allNotesCache.get(versionKey)
	if (!notes) {
		notes = TaskGroupServiceClient.listAllNotes(EmptyRequest.create({})).then(
			(response) => response.groups ?? [],
			(error) => {
				console.error("Failed to load task notes:", error)
				allNotesCache.delete(versionKey)
				return []
			},
		)
		allNotesCache.set(versionKey, notes)
	}
	return notes
}

export function clearNoteMentionCache(): void {
	allNotesCache.clear()
}

/** Every task's notes for the `#` menu, fetched once per task-group snapshot. */
export function useAllNotes(taskGroups: readonly TaskGroupSummary[] | undefined): TaskGroupNotes[] {
	const versionKey = (taskGroups ?? []).map((g) => `${g.id}:${g.noteCount}`).join(",")
	const [groups, setGroups] = useState<TaskGroupNotes[]>([])
	useEffect(() => {
		if (!taskGroups?.length) {
			setGroups([])
			return
		}
		let cancelled = false
		fetchAllNotes(versionKey).then((result) => {
			if (!cancelled) setGroups(result)
		})
		return () => {
			cancelled = true
		}
	}, [versionKey, taskGroups?.length])
	return useMemo(() => groups, [groups])
}
