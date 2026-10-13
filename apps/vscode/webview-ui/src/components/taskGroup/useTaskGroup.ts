import {
	GetTaskGroupRequest,
	type GetTaskGroupResponse,
	OpenNoteRequest,
	type TaskTag as ProtoTaskTag,
} from "@shared/proto/cline/task_group"
import type { NotebookNoteMeta, TaskGroupSummary, TaskGroupThreadRow, TaskTag } from "@shared/task-groups"
import { useCallback, useEffect, useRef, useState } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { TaskGroupServiceClient } from "@/services/grpc-client"

export interface TaskGroupDetails {
	group: TaskGroupSummary
	notes: NotebookNoteMeta[]
	threads: TaskGroupThreadRow[]
}

/** State posts arrive in bursts while chats stream; refetches inside this window coalesce into one. */
const REFETCH_WINDOW_MS = 500

function tagFromProto(tag: ProtoTaskTag): TaskTag {
	return {
		kind: tag.kind === "ticket" || tag.kind === "branch" ? tag.kind : "label",
		value: tag.value,
		source: tag.source === "auto" ? "auto" : "user",
	}
}

export function taskGroupDetailsFromProto(response: GetTaskGroupResponse): TaskGroupDetails | undefined {
	const group = response.group
	if (!group) return undefined
	return {
		group: {
			id: group.id,
			title: group.title,
			tags: group.tags.map(tagFromProto),
			createdAt: group.createdAt,
			updatedAt: group.updatedAt,
			noteCount: group.noteCount,
		},
		notes: response.notes.map((note) => ({
			slug: note.slug,
			name: note.name,
			description: note.description,
			size: note.size,
			updatedAt: note.updatedAt,
			updatedBy:
				note.updatedBy?.kind === "thread"
					? { kind: "thread", threadId: note.updatedBy.threadId, threadTitle: note.updatedBy.threadTitle }
					: { kind: "user" },
			readers: note.readers,
		})),
		threads: response.threads.map((thread) => ({
			threadId: thread.threadId,
			title: thread.title || undefined,
			task: thread.task,
			ts: thread.ts,
			parentTaskId: thread.parentTaskId,
			isSubagent: thread.isSubagent,
			read: thread.read,
			wrote: thread.wrote,
		})),
	}
}

/**
 * Loads a task group's page data (group, notes, timeline). Refetches whenever
 * `taskGroups` state changes: the backend watcher posts state when notes are
 * edited on disk, so the page picks up hand edits and applied changes.
 */
export function useTaskGroup(id: string) {
	const { taskGroups } = useExtensionState()
	const [details, setDetails] = useState<TaskGroupDetails>()
	const [missing, setMissing] = useState(false)
	const requestRef = useRef(0)
	const timerRef = useRef<ReturnType<typeof setTimeout>>()

	const refresh = useCallback(() => {
		const request = ++requestRef.current
		TaskGroupServiceClient.getTaskGroup(GetTaskGroupRequest.create({ id }))
			.then((response) => {
				if (request !== requestRef.current) return
				const next = taskGroupDetailsFromProto(response)
				setDetails(next)
				setMissing(!next)
			})
			.catch((error) => {
				if (request !== requestRef.current) return
				console.error("Failed to load task:", error)
				setMissing(true)
			})
	}, [id])

	// A different task starts from a clean slate.
	useEffect(() => {
		setDetails(undefined)
		setMissing(false)
		refresh()
	}, [refresh])

	const firstStateRef = useRef(true)
	// biome-ignore lint/correctness/useExhaustiveDependencies: taskGroups is the refetch signal
	useEffect(() => {
		if (firstStateRef.current) {
			firstStateRef.current = false
			return
		}
		if (timerRef.current) return
		timerRef.current = setTimeout(() => {
			timerRef.current = undefined
			refresh()
		}, REFETCH_WINDOW_MS)
	}, [taskGroups])

	useEffect(() => () => clearTimeout(timerRef.current), [])

	return { details, missing, refresh, setDetails }
}

/** Opens a note's markdown file in the editor. */
export function openNote(taskGroupId: string, slug: string): void {
	TaskGroupServiceClient.openNote(OpenNoteRequest.create({ taskGroupId, slug })).catch((error) =>
		console.error("Failed to open note:", error),
	)
}

/** Note size for list rows: "820 B", "1.2 KB". */
export function formatNoteSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`
	const kb = bytes / 1024
	return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`
}

/** Thread label in the timeline and menus: the user title, else the first message. */
export function threadRowTitle(thread: Pick<TaskGroupThreadRow, "title" | "task">): string {
	return (thread.title?.trim() || thread.task.trim() || "New thread").replace(/\s+/g, " ")
}

// "＋ New" on the task page opens the notebook page with its new-note form
// already open. The page state is just { id, page }, so the request rides here.
let newNoteRequested = false

export function requestNewNoteForm(): void {
	newNoteRequested = true
}

export function consumeNewNoteRequest(): boolean {
	const requested = newNoteRequested
	newNoteRequested = false
	return requested
}

/**
 * ChatView glue for the task page, which replaces chat/home in the sidebar.
 * Opening it from a thread goes home first (the thread keeps running) so its
 * composer starts a new thread in the task; a thread opening from anywhere
 * (the timeline, a send, the inbox) closes it again.
 */
export function useTaskGroupPageNavigation({
	taskTs,
	closeThread,
	onPageOpen,
}: {
	/** ts of the thread on screen, undefined on home. */
	taskTs: number | undefined
	closeThread: () => void
	/** Runs when a task page opens (e.g. to leave search). */
	onPageOpen?: () => void
}): (taskGroupId: string) => void {
	const { taskGroupView, navigateToTaskGroup, hideTaskGroupView } = useExtensionState()
	const taskGroupViewId = taskGroupView?.id
	const latestRef = useRef({ taskTs, closeThread, onPageOpen })
	latestRef.current = { taskTs, closeThread, onPageOpen }

	useEffect(() => {
		if (!taskGroupViewId) return
		const { taskTs: openTs, closeThread: close, onPageOpen: opened } = latestRef.current
		opened?.()
		if (openTs !== undefined) close()
	}, [taskGroupViewId])

	const previousTsRef = useRef(taskTs)
	useEffect(() => {
		const previous = previousTsRef.current
		previousTsRef.current = taskTs
		if (taskTs !== undefined && taskTs !== previous) hideTaskGroupView()
	}, [taskTs, hideTaskGroupView])

	return useCallback((taskGroupId: string) => navigateToTaskGroup(taskGroupId), [navigateToTaskGroup])
}
