// Task groups ("Tasks" in the UI): a named group of threads with a shared
// notebook. Named TaskGroup/taskGroupId internally because `task*` already
// means a single chat/session everywhere else in this codebase.

export type TaskTagKind = "ticket" | "branch" | "label"
export interface TaskTag {
	kind: TaskTagKind
	value: string
	source: "user" | "auto"
}
export interface TaskGroup {
	id: string
	title: string
	tags: TaskTag[]
	createdAt: number
	updatedAt: number
	/** The user dismissed the composer's "Add to this task?" branch suggestion for this task. */
	branchSuggestionDismissed?: boolean
}
export interface TaskGroupSummary extends TaskGroup {
	noteCount: number
}
export interface NotebookNoteMeta {
	slug: string
	name: string
	description: string
	size: number
	updatedAt: number
	updatedBy: { kind: "user" } | { kind: "thread"; threadId: string; threadTitle: string }
	readers: number // distinct threads that read it (from activity log)
}
export type NotebookChangeOp = "create" | "update" | "delete"
export interface NotebookChange {
	op: NotebookChangeOp
	slug: string
	name: string
	description: string
	content?: string
	baseUpdatedAt?: number
}
export interface NotebookActivity {
	ts: number
	threadId: string
	kind: "read" | "write"
	slug: string
}

export interface NotebookChangesPayload {
	revision: string
	taskGroupId: string
	threadId: string
	status: "pending" | "applied" | "discarded"
	changes: NotebookChange[]
	appliedSlugs?: string[]
}

/** A thread row in a task group's timeline (newest first). read/wrote are note slugs from the activity log. */
export interface TaskGroupThreadRow {
	threadId: string
	title?: string
	task: string
	/** Last activity. */
	ts: number
	/** When the thread was created; the timeline reads in this order. */
	startedTs: number
	parentTaskId?: string
	isSubagent: boolean
	read: string[]
	wrote: string[]
}

/**
 * Thread context supplied to server-side history search: `title` is the
 * resolved display title (`HistoryItem.title || task`) and `taskGroupId` the
 * effective group (a subagent inherits its root thread's group).
 */
export interface HistorySearchThread {
	id: string
	title: string
	ts: number
	taskGroupId?: string
}

/** One server-side history-search hit; maps 1:1 onto proto SearchHistoryResult. */
export interface HistorySearchHit {
	kind: "note" | "message"
	id: string
	title: string
	snippet: string
	ts: number
	taskGroupId?: string
	threadId?: string
}
