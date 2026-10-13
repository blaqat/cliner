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

/** A thread row in a task group's timeline (newest first). read/wrote are note slugs from the activity log. */
export interface TaskGroupThreadRow {
	threadId: string
	title?: string
	task: string
	ts: number
	parentTaskId?: string
	isSubagent: boolean
	read: string[]
	wrote: string[]
}
