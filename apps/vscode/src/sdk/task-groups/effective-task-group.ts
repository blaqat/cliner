import type { HistoryItem } from "@shared/HistoryItem"

type TaskGroupFields = Pick<HistoryItem, "id" | "isSubagent" | "parentTaskId" | "runtimeOwnerTaskId" | "taskGroupId">

/**
 * The thread an item takes its task from: a subagent follows the thread that
 * owns its runtime, an aside follows the thread it was forked from. Standalone
 * threads own their `taskGroupId` and follow nothing.
 */
export function taskGroupSourceId(item: TaskGroupFields): string | undefined {
	if (item.isSubagent) return item.runtimeOwnerTaskId ?? item.parentTaskId ?? undefined
	return item.parentTaskId || undefined
}

/** True for a thread forked from another (a subagent is not an aside). */
export function isAsideThread(item: Pick<HistoryItem, "isSubagent" | "parentTaskId">): boolean {
	return !item.isSubagent && !!item.parentTaskId
}

/**
 * Walks `item` up through subagent owners and aside parents to the thread that
 * owns the task. Rule: an aside always belongs to its parent's task, whatever
 * its own stored `taskGroupId` says, so asides filed wrong before the cascade
 * existed resolve correctly at read time. A subagent whose owner is missing has
 * no task; an aside whose parent was deleted falls back to its own stored one.
 */
export async function resolveEffectiveTaskGroupId(
	item: TaskGroupFields,
	findThread: (id: string) => Promise<TaskGroupFields | undefined> | TaskGroupFields | undefined,
): Promise<string | undefined> {
	let current = item
	const seen = new Set<string>([item.id])
	for (;;) {
		const sourceId = taskGroupSourceId(current)
		const own = current.isSubagent ? undefined : current.taskGroupId || undefined
		if (!sourceId || seen.has(sourceId)) return own
		seen.add(sourceId)
		const source = await findThread(sourceId)
		if (!source) return own
		current = source
	}
}

/** Synchronous variant of {@link resolveEffectiveTaskGroupId} over an id index. */
export function effectiveTaskGroupId(item: TaskGroupFields, byId: ReadonlyMap<string, TaskGroupFields>): string | undefined {
	let current = item
	const seen = new Set<string>([item.id])
	for (;;) {
		const sourceId = taskGroupSourceId(current)
		const own = current.isSubagent ? undefined : current.taskGroupId || undefined
		if (!sourceId || seen.has(sourceId)) return own
		seen.add(sourceId)
		const source = byId.get(sourceId)
		if (!source) return own
		current = source
	}
}

/**
 * Items with their asides' stored task replaced by the effective one (their
 * parent's). Subagents are left alone: their task is derived by their readers.
 */
export function withEffectiveTaskGroups<T extends HistoryItem>(items: readonly T[]): T[] {
	const byId = new Map(items.map((item) => [item.id, item]))
	return items.map((item) => {
		if (!isAsideThread(item)) return item
		const effective = effectiveTaskGroupId(item, byId)
		return (item.taskGroupId || undefined) === effective ? item : { ...item, taskGroupId: effective }
	})
}

/**
 * Every non-subagent thread that descends from `rootId` through asides (nested
 * asides, and asides of its subagents), excluding the root itself.
 */
export function asideDescendantIds(rootId: string, items: readonly TaskGroupFields[]): string[] {
	const childrenOf = new Map<string, TaskGroupFields[]>()
	for (const item of items) {
		const source = taskGroupSourceId(item)
		if (!source) continue
		const siblings = childrenOf.get(source) ?? []
		siblings.push(item)
		childrenOf.set(source, siblings)
	}
	const found: string[] = []
	const seen = new Set<string>([rootId])
	const queue = [rootId]
	for (const id of queue) {
		for (const child of childrenOf.get(id) ?? []) {
			if (seen.has(child.id)) continue
			seen.add(child.id)
			queue.push(child.id)
			if (!child.isSubagent) found.push(child.id)
		}
	}
	return found
}

/** The thread an aside chain was forked from (the thread itself when it is not an aside). */
export function asideRootId(id: string, byId: ReadonlyMap<string, TaskGroupFields>): string {
	let rootId = id
	const seen = new Set<string>([id])
	for (let item = byId.get(rootId); item && !item.isSubagent && item.parentTaskId; item = byId.get(rootId)) {
		if (seen.has(item.parentTaskId) || !byId.has(item.parentTaskId)) break
		seen.add(item.parentTaskId)
		rootId = item.parentTaskId
	}
	return rootId
}
