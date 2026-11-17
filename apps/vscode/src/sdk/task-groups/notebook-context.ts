import type { HistoryItem } from "@shared/HistoryItem"
import type { TaskGroup } from "@shared/task-groups"
import { resolveEffectiveTaskGroupId } from "./effective-task-group"
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
	const seen = new Set<string>([item.id])
	while (current.isSubagent) {
		const parentId = current.runtimeOwnerTaskId ?? current.parentTaskId
		if (!parentId || seen.has(parentId)) break
		seen.add(parentId)
		const parent = await findThread(parentId)
		if (!parent) break
		current = parent
	}
	// `rootThreadId` is the user-facing thread that owns pending edits and reads (an aside is
	// its own thread, with its own chat to review them in). The task itself resolves further
	// through aside parents: an aside always belongs to its parent's task.
	return {
		rootThreadId: current.id,
		taskGroupId: current.isSubagent ? undefined : await resolveEffectiveTaskGroupId(current, findThread),
	}
}
