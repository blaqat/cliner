import type { HistoryItem } from "@shared/HistoryItem"
import type { TaskGroup } from "@shared/task-groups"
import type { NotebookStore } from "./notebook-store"

export interface TaskNotebookContext {
	group: TaskGroup
	threadId: string
	rootThreadId: string
	store: NotebookStore
	resolveReaderThreadId?: (agentId: string | undefined) => string
}

export async function resolveNotebookOwner(
	item: HistoryItem,
	findThread: (id: string) => Promise<HistoryItem | undefined>,
): Promise<{ rootThreadId: string; taskGroupId?: string }> {
	let current = item
	let taskGroupId = item.isSubagent ? undefined : item.taskGroupId
	const seen = new Set<string>([item.id])
	while (true) {
		const parentId = current.runtimeOwnerTaskId ?? current.parentTaskId
		if (!parentId || seen.has(parentId)) break
		seen.add(parentId)
		const parent = await findThread(parentId)
		if (!parent) break
		current = parent
		if (!current.isSubagent) taskGroupId ??= current.taskGroupId
	}
	return { rootThreadId: current.id, taskGroupId }
}
