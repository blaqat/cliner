import {
	NotebookNoteUpdatedBy,
	NotebookNoteMeta as ProtoNotebookNoteMeta,
	TaskGroupSummary as ProtoTaskGroupSummary,
	TaskGroupThread as ProtoTaskGroupThread,
	TaskTag as ProtoTaskTag,
} from "@shared/proto/cline/task_group"
import type { NotebookNoteMeta, TaskGroupSummary, TaskGroupThreadRow, TaskTag } from "@shared/task-groups"

/** proto TaskTag (plain strings) -> shared TaskTag (literal unions), coercing unknown values. */
export function protoToTaskTag(tag: ProtoTaskTag): TaskTag {
	return {
		kind: tag.kind === "ticket" || tag.kind === "branch" ? tag.kind : "label",
		value: tag.value,
		source: tag.source === "auto" ? "auto" : "user",
	}
}

export function taskTagToProto(tag: TaskTag): ProtoTaskTag {
	return ProtoTaskTag.create({ kind: tag.kind, value: tag.value, source: tag.source })
}

export function taskGroupSummaryToProto(group: TaskGroupSummary): ProtoTaskGroupSummary {
	return ProtoTaskGroupSummary.create({
		id: group.id,
		title: group.title,
		tags: group.tags.map(taskTagToProto),
		createdAt: group.createdAt,
		updatedAt: group.updatedAt,
		noteCount: group.noteCount,
	})
}

export function notebookNoteMetaToProto(note: NotebookNoteMeta): ProtoNotebookNoteMeta {
	return ProtoNotebookNoteMeta.create({
		slug: note.slug,
		name: note.name,
		description: note.description,
		size: note.size,
		updatedAt: note.updatedAt,
		updatedBy:
			note.updatedBy.kind === "thread"
				? NotebookNoteUpdatedBy.create({
						kind: "thread",
						threadId: note.updatedBy.threadId,
						threadTitle: note.updatedBy.threadTitle,
					})
				: NotebookNoteUpdatedBy.create({ kind: "user" }),
		readers: note.readers,
	})
}

export function taskGroupThreadToProto(row: TaskGroupThreadRow): ProtoTaskGroupThread {
	return ProtoTaskGroupThread.create({
		threadId: row.threadId,
		title: row.title ?? "",
		task: row.task,
		ts: row.ts,
		parentTaskId: row.parentTaskId,
		isSubagent: row.isSubagent,
		read: row.read,
		wrote: row.wrote,
	})
}
