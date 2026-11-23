import type { HistoryItem } from "@shared/HistoryItem"
import type { ThreadWorktree, WorktreeSummary } from "@shared/thread-worktrees"
import { effectiveTaskGroupId, isAsideThread, taskGroupSourceId } from "./effective-task-group"

/** One thread that goes when its task is deleted with its threads (see TaskGroupDeleteThread in the proto). */
export interface TaskGroupDeleteThread {
	id: string
	title: string
	running: boolean
	busyElsewhere: boolean
	aside: boolean
	hasWorktree: boolean
	worktreeLosses: number
	worktreeNote: string
	subagents: number
}

export interface TaskGroupDeleteResult {
	deleted: boolean
	blocked?: string
	preview?: TaskGroupDeleteThread[]
}

/** What the delete needs from the controller; each call is the existing path the single-thread actions use. */
export interface TaskGroupDeleteDeps {
	/** Every history row, subagents included. */
	listThreads(): Promise<HistoryItem[]>
	/** Loaded in this window (running or not): deleting stops it here. */
	isLoaded(id: string): boolean
	isRunning(id: string): boolean
	worktrees: {
		get(id: string): Promise<ThreadWorktree | undefined>
		summary(id: string): Promise<WorktreeSummary>
		/** Throws when another window or session holds the thread. */
		assertIdle(id: string): Promise<void>
		remove(
			id: string,
			confirmed: boolean,
			beforeRemove?: () => Promise<void>,
		): Promise<{ warning?: string; message?: string } | unknown>
	}
	/** Fences new turns on the thread until the returned release. */
	beginDeletion(id: string): () => void
	/** Stops the thread's session in this window and releases its worktree lease. */
	stopThread(id: string): Promise<void>
	/** Deletes history rows (and, through the SDK, their subagent sessions). */
	deleteThreads(ids: string[]): Promise<void>
	deleteGroup(id: string): Promise<void>
}

const threadTitle = (item: Pick<HistoryItem, "title" | "task">) =>
	(item.title?.trim() || item.task?.trim() || "New thread").replace(/\s+/g, " ")

const files = (count: number) => `${count} changed file${count === 1 ? "" : "s"}`

/** The thread a subagent belongs to: up through subagent owners to the first non-subagent. */
function rootThreadId(item: HistoryItem, byId: ReadonlyMap<string, HistoryItem>): string | undefined {
	let current: HistoryItem | undefined = item
	const seen = new Set<string>()
	while (current?.isSubagent) {
		if (seen.has(current.id)) return undefined
		seen.add(current.id)
		const source = taskGroupSourceId(current)
		current = source ? byId.get(source) : undefined
	}
	return current?.id
}

/**
 * The task's threads (its own and their side threads; subagents counted on the thread they run
 * under) and, for each, what deleting it stops, removes and loses. Read-only.
 */
export async function previewTaskGroupDelete(groupId: string, deps: TaskGroupDeleteDeps): Promise<TaskGroupDeleteThread[]> {
	const items = await deps.listThreads()
	const byId = new Map(items.map((item) => [item.id, item]))
	const members = items.filter((item) => effectiveTaskGroupId(item, byId) === groupId)
	const rows = new Map<string, TaskGroupDeleteThread>()
	for (const item of members) {
		if (item.isSubagent) continue
		rows.set(item.id, {
			id: item.id,
			title: threadTitle(item),
			running: deps.isRunning(item.id),
			busyElsewhere: false,
			aside: isAsideThread(item) && !!item.parentTaskId && byId.has(item.parentTaskId),
			hasWorktree: false,
			worktreeLosses: 0,
			worktreeNote: "",
			subagents: 0,
		})
	}
	for (const item of members) {
		if (!item.isSubagent) continue
		const row = rows.get(rootThreadId(item, byId) ?? "")
		if (!row) continue
		row.subagents += 1
		if (deps.isRunning(item.id)) row.running = true
	}
	for (const item of members) {
		const row = rows.get(item.isSubagent ? (rootThreadId(item, byId) ?? "") : item.id)
		if (!row) continue
		// Every local session holds a lease while active, worktree or not; one held elsewhere blocks the
		// delete. Only a run here is ours to stop: a thread merely loaded here can still be running there.
		if (!deps.isRunning(item.id)) {
			try {
				await deps.worktrees.assertIdle(item.id)
			} catch {
				row.busyElsewhere = true
			}
		}
		const mapping = await deps.worktrees.get(item.id).catch(() => undefined)
		if (!mapping) continue
		row.hasWorktree = true
		if (row.busyElsewhere) continue
		try {
			const summary = await deps.worktrees.summary(item.id)
			if (summary.loseOnRemove > 0) {
				row.worktreeLosses += summary.loseOnRemove
				row.worktreeNote = summary.takenOver
					? `has ${files(summary.loseOnRemove)} of its own in its leftover worktree folder. They'll be discarded.`
					: `has ${files(row.worktreeLosses)} in its worktree that were never copied to your workspace. They'll be discarded.`
			}
		} catch (error) {
			// An unreadable worktree counts as unsaved work: removing it needs the same explicit yes.
			row.worktreeLosses = Math.max(row.worktreeLosses, 1)
			row.worktreeNote = `has a worktree that couldn't be checked (${(error as Error).message.trim()}). Anything in it will be discarded.`
		}
	}
	return [...rows.values()]
}

/**
 * Deletes the task and every thread in it. Checks first and deletes nothing when a thread is busy in
 * another window, or when a worktree holds unsaved work the user didn't agree to discard. Running
 * threads here are stopped; each worktree goes through the worktree manager's own removal, whose
 * warnings (unsaved work, submodule caches) stop the delete unless `discard` was given.
 */
export async function deleteTaskGroupWithThreads(
	groupId: string,
	discard: boolean,
	deps: TaskGroupDeleteDeps,
): Promise<TaskGroupDeleteResult> {
	const preview = await previewTaskGroupDelete(groupId, deps)
	const busy = preview.filter((thread) => thread.busyElsewhere)
	if (busy.length)
		return {
			deleted: false,
			blocked: `${quoteList(busy)} ${busy.length === 1 ? "is" : "are"} running in another window. Stop ${busy.length === 1 ? "it" : "them"} there first.`,
			preview,
		}
	const losing = preview.filter((thread) => thread.worktreeLosses > 0)
	if (losing.length && !discard)
		return {
			deleted: false,
			blocked: `${quoteList(losing)} ${losing.length === 1 ? "has" : "have"} worktree changes that were never copied to your workspace.`,
			preview,
		}

	const items = await deps.listThreads()
	const byId = new Map(items.map((item) => [item.id, item]))
	const ids = new Set(preview.map((thread) => thread.id))
	// Subagent rows carry their own sessions and maybe worktrees; they go with their thread.
	const all = items.filter((item) => ids.has(item.id) || ids.has(rootThreadId(item, byId) ?? "")).map((item) => item.id)
	const releases = all.map((id) => deps.beginDeletion(id))
	try {
		for (const id of all) if (deps.isLoaded(id)) await deps.stopThread(id)
		let removed = 0
		for (const id of all) {
			if (!(await deps.worktrees.get(id).catch(() => undefined))) continue
			let result: unknown
			try {
				result = await deps.worktrees.remove(id, discard, () => deps.stopThread(id))
			} catch (error) {
				return { deleted: false, blocked: removalStopped(id, byId, (error as Error).message, removed), preview }
			}
			const warning = (result as { warning?: string } | undefined)?.warning
			if (warning) return { deleted: false, blocked: removalStopped(id, byId, warning, removed), preview }
			removed += 1
		}
		// The task goes first: a window showing one of its threads then lands home, not on a task that's about to go.
		await deps.deleteGroup(groupId)
		if (ids.size) await deps.deleteThreads([...ids])
		return { deleted: true }
	} finally {
		for (const release of releases) release()
	}
}

/** Why the delete stopped at a worktree, and what it already did. */
function removalStopped(id: string, byId: ReadonlyMap<string, HistoryItem>, reason: string, removed: number): string {
	const item = byId.get(id)
	const title = item ? threadTitle(item.isSubagent ? (byId.get(rootThreadId(item, byId) ?? "") ?? item) : item) : "a thread"
	const done = removed
		? ` No thread was deleted; ${removed === 1 ? "1 worktree was" : `${removed} worktrees were`} already removed.`
		: " Nothing was deleted."
	return `“${title}” worktree: ${reason.trim()}${done}`
}

function quoteList(threads: readonly { title: string }[]): string {
	const names = threads.map((thread) => `“${thread.title}”`)
	return names.length <= 2 ? names.join(" and ") : `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`
}
