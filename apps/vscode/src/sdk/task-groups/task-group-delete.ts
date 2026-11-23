import type { HistoryItem } from "@shared/HistoryItem"
import type { ThreadWorktree, WorktreeSummary } from "@shared/thread-worktrees"
import { taskWorktreeKey } from "../worktrees/thread-worktree-manager"
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
	/** Runs in the task's shared worktree (it, an aside or a subagent of it). */
	usesTaskWorktree: boolean
}

/** The worktree the task owns and its threads share (see TaskGroupDeleteTaskWorktree in the proto). */
export interface TaskGroupDeleteTaskWorktree {
	branch: string
	losses: number
	note: string
	refWarning: string
	runningHere: string[]
	busyElsewhere: boolean
}

export interface TaskGroupDeletePreview {
	threads: TaskGroupDeleteThread[]
	taskWorktree?: TaskGroupDeleteTaskWorktree
}

export interface TaskGroupDeleteResult {
	deleted: boolean
	blocked?: string
	preview?: TaskGroupDeletePreview
}

/** What the delete needs from the controller; each call is the existing path the single-thread actions use. */
export interface TaskGroupDeleteDeps {
	/** Every history row, subagents included. */
	listThreads(): Promise<HistoryItem[]>
	/** Loaded in this window (running or not): deleting stops it here. */
	isLoaded(id: string): boolean
	isRunning(id: string): boolean
	/** Whether the thread runs in its task's shared worktree rather than its own or the workspace. */
	usesTaskWorktree(id: string): Promise<boolean>
	worktrees: {
		get(id: string): Promise<ThreadWorktree | undefined>
		summary(id: string): Promise<WorktreeSummary>
		/** Throws when another window or session holds the thread. */
		assertIdle(id: string): Promise<void>
		/** A live session (here or elsewhere) holds the worktree. */
		worktreeBusy(id: string): Promise<boolean>
		remove(
			id: string,
			confirmed: boolean,
			beforeRemove?: () => Promise<void>,
		): Promise<{ warning?: string; message?: string } | unknown>
	}
	/** The removal's Git ref scan: work only the worktree's folders hold, worded for the user. Read-only. */
	refScan(mapping: ThreadWorktree): Promise<string | undefined>
	/** Fences new turns on the thread until the returned release. */
	beginDeletion(id: string): () => void
	/** Stops the thread's session in this window and releases its worktree lease. */
	stopThread(id: string): Promise<void>
	/** Deletes history rows (and, through the SDK, their subagent sessions). */
	deleteThreads(ids: string[]): Promise<void>
	/** Deletes the task and unfiles its threads; refuses while a task worktree remains. */
	deleteGroup(id: string): Promise<void>
}

const threadTitle = (item: Pick<HistoryItem, "title" | "task">) =>
	(item.title?.trim() || item.task?.trim() || "New thread").replace(/\s+/g, " ")

const files = (count: number) => `${count} changed file${count === 1 ? "" : "s"}`
/** "were never copied … They'll be discarded", in the number of `files(count)`. */
const were = (count: number) => (count === 1 ? "was" : "were")
const theyll = (count: number) => (count === 1 ? "It'll" : "They'll")

const TASK_WORKTREE_LOSES = "The task worktree has work that was never copied to your workspace."

const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).trim()

/** The task worktree holds something removing it discards: files never copied, or Git work the ref scan found. */
export const taskWorktreeLoses = (worktree: TaskGroupDeleteTaskWorktree | undefined) =>
	!!worktree && (worktree.losses > 0 || !!worktree.refWarning)

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
 * under) and, for each, what deleting it stops, removes and loses; plus the task's own worktree,
 * which goes first with either choice. Read-only.
 */
export async function previewTaskGroupDelete(groupId: string, deps: TaskGroupDeleteDeps): Promise<TaskGroupDeletePreview> {
	const items = await deps.listThreads()
	const byId = new Map(items.map((item) => [item.id, item]))
	const members = items.filter((item) => effectiveTaskGroupId(item, byId) === groupId)
	const taskMapping = await deps.worktrees.get(taskWorktreeKey(groupId)).catch(() => undefined)
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
			usesTaskWorktree: false,
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
		if (taskMapping && (await deps.usesTaskWorktree(item.id).catch(() => false))) row.usesTaskWorktree = true
		const mapping = await deps.worktrees.get(item.id).catch(() => undefined)
		if (!mapping) continue
		row.hasWorktree = true
		if (row.busyElsewhere) continue
		try {
			const summary = await deps.worktrees.summary(item.id)
			if (summary.loseOnRemove > 0) {
				row.worktreeLosses += summary.loseOnRemove
				row.worktreeNote = summary.takenOver
					? `has ${files(summary.loseOnRemove)} of its own in its leftover worktree folder. ${theyll(summary.loseOnRemove)} be discarded.`
					: `has ${files(row.worktreeLosses)} in its worktree that ${were(row.worktreeLosses)} never copied to your workspace. ${theyll(row.worktreeLosses)} be discarded.`
			}
		} catch (error) {
			// An unreadable worktree counts as unsaved work: removing it needs the same explicit yes.
			row.worktreeLosses = Math.max(row.worktreeLosses, 1)
			row.worktreeNote = `has a worktree that couldn't be checked (${message(error)}). Anything in it will be discarded.`
		}
	}
	const threads = [...rows.values()]
	return taskMapping ? { threads, taskWorktree: await previewTaskWorktree(taskMapping, threads, deps) } : { threads }
}

/** What removing the task's worktree stops, needs and loses; the same checks its own Remove makes. */
async function previewTaskWorktree(
	mapping: ThreadWorktree,
	threads: readonly TaskGroupDeleteThread[],
	deps: TaskGroupDeleteDeps,
): Promise<TaskGroupDeleteTaskWorktree> {
	const using = threads.filter((thread) => thread.usesTaskWorktree)
	const runningHere = using.filter((thread) => thread.running && !thread.busyElsewhere).map((thread) => thread.title)
	// A run here holds the worktree's lease too, so with none here a held lease is another window's.
	const busyElsewhere =
		using.some((thread) => thread.busyElsewhere) ||
		(!runningHere.length && (await deps.worktrees.worktreeBusy(mapping.threadId).catch(() => true)))
	const worktree: TaskGroupDeleteTaskWorktree = {
		branch: mapping.branch,
		losses: 0,
		note: "",
		refWarning: "",
		runningHere,
		busyElsewhere,
	}
	// Its files change while a thread runs in it; the delete re-checks once that has stopped.
	if (busyElsewhere || runningHere.length) return worktree
	try {
		const summary = await deps.worktrees.summary(mapping.threadId)
		if (summary.loseOnRemove > 0) {
			worktree.losses = summary.loseOnRemove
			worktree.note = summary.takenOver
				? `The task worktree’s leftover folder has ${files(summary.loseOnRemove)} of its own. ${theyll(summary.loseOnRemove)} be discarded.`
				: `The task worktree has ${files(summary.loseOnRemove)} that ${were(summary.loseOnRemove)} never copied to your workspace. ${theyll(summary.loseOnRemove)} be discarded.`
		}
	} catch (error) {
		worktree.losses = 1
		worktree.note = `The task worktree couldn’t be checked (${message(error)}). Anything in it will be discarded.`
	}
	try {
		worktree.refWarning = (await deps.refScan(mapping))?.trim() ?? ""
	} catch (error) {
		worktree.refWarning = `Couldn’t check Git work in ${mapping.cwd} (${message(error)}). Inspect it by hand, or discard to continue.`
	}
	return worktree
}

/**
 * Removes the task's worktree through the worktree manager's own removal (lease check, ref scan,
 * unsaved work). Returns why it stopped, or undefined once it's gone (or there was none).
 */
async function removeTaskWorktree(
	groupId: string,
	discard: boolean,
	deps: TaskGroupDeleteDeps,
	nothingDone: string,
): Promise<string | undefined> {
	const id = taskWorktreeKey(groupId)
	if (!(await deps.worktrees.get(id).catch(() => undefined))) return undefined
	let result: unknown
	try {
		result = await deps.worktrees.remove(id, discard)
	} catch (error) {
		return `Task worktree: ${message(error)}${nothingDone}`
	}
	const warning = (result as { warning?: string } | undefined)?.warning
	return warning ? `Task worktree: ${warning.trim()}${nothingDone}` : undefined
}

/**
 * Deletes just the task: its threads stay, unfiled. A task worktree goes first, through the
 * manager's removal, so no kept thread is left pointing at it: they continue in the workspace.
 * Refused while a thread runs in that worktree (here or elsewhere) or it holds work the user
 * didn't agree to discard.
 */
export async function deleteTaskGroupOnly(
	groupId: string,
	discard: boolean,
	deps: TaskGroupDeleteDeps,
): Promise<TaskGroupDeleteResult> {
	if (await deps.worktrees.get(taskWorktreeKey(groupId)).catch(() => undefined)) {
		const preview = await previewTaskGroupDelete(groupId, deps)
		const worktree = preview.taskWorktree
		if (worktree?.runningHere.length) {
			const one = worktree.runningHere.length === 1
			return {
				deleted: false,
				blocked: `${quoteList(worktree.runningHere.map((title) => ({ title })))} ${one ? "is" : "are"} running in the task worktree. Stop ${one ? "it" : "them"} or wait for ${one ? "it" : "them"} to finish first.`,
				preview,
			}
		}
		if (worktree?.busyElsewhere)
			return {
				deleted: false,
				blocked: "A thread using the task worktree is running in another window. Stop it there first.",
				preview,
			}
		if (taskWorktreeLoses(worktree) && !discard)
			return {
				deleted: false,
				blocked: TASK_WORKTREE_LOSES,
				preview,
			}
		const stopped = await removeTaskWorktree(groupId, discard, deps, " Nothing was deleted.")
		if (stopped) return { deleted: false, blocked: stopped, preview: await previewTaskGroupDelete(groupId, deps) }
	}
	try {
		await deps.deleteGroup(groupId)
	} catch (error) {
		return { deleted: false, blocked: `Couldn’t delete the task: ${message(error)}` }
	}
	return { deleted: true }
}

/**
 * Deletes the task and every thread in it. Checks first and deletes nothing when a thread is busy in
 * another window, or when a worktree holds unsaved work the user didn't agree to discard. Running
 * threads here are stopped; the task's worktree, then each thread's, goes through the worktree
 * manager's own removal, whose warnings (unsaved work, Git refs only they hold) stop the delete
 * unless `discard` was given.
 */
export async function deleteTaskGroupWithThreads(
	groupId: string,
	discard: boolean,
	deps: TaskGroupDeleteDeps,
): Promise<TaskGroupDeleteResult> {
	const preview = await previewTaskGroupDelete(groupId, deps)
	const busy = preview.threads.filter((thread) => thread.busyElsewhere)
	if (busy.length)
		return {
			deleted: false,
			blocked: `${quoteList(busy)} ${busy.length === 1 ? "is" : "are"} running in another window. Stop ${busy.length === 1 ? "it" : "them"} there first.`,
			preview,
		}
	if (preview.taskWorktree?.busyElsewhere)
		return {
			deleted: false,
			blocked: "A thread using the task worktree is running in another window. Stop it there first.",
			preview,
		}
	const losing: { title: string }[] = preview.threads.filter((thread) => thread.worktreeLosses > 0)
	if (taskWorktreeLoses(preview.taskWorktree)) losing.unshift({ title: "the task worktree" })
	if (losing.length && !discard)
		return {
			deleted: false,
			blocked:
				losing.length === 1 && preview.taskWorktree && taskWorktreeLoses(preview.taskWorktree)
					? TASK_WORKTREE_LOSES
					: `${quoteList(losing)} ${losing.length === 1 ? "has" : "have"} worktree changes that were never copied to your workspace.`,
			preview,
		}

	const items = await deps.listThreads()
	const byId = new Map(items.map((item) => [item.id, item]))
	const ids = new Set(preview.threads.map((thread) => thread.id))
	// Subagent rows carry their own sessions and maybe worktrees; they go with their thread.
	const all = items.filter((item) => ids.has(item.id) || ids.has(rootThreadId(item, byId) ?? "")).map((item) => item.id)
	const releases = all.map((id) => deps.beginDeletion(id))
	try {
		// Stopping here releases the leases this window holds on the task worktree, so its removal can go ahead.
		for (const id of all) if (deps.isLoaded(id)) await deps.stopThread(id)
		const taskStopped = await removeTaskWorktree(groupId, discard, deps, " Nothing was deleted.")
		if (taskStopped) return { deleted: false, blocked: taskStopped, preview }
		let removed = preview.taskWorktree ? 1 : 0
		for (const id of all) {
			if (!(await deps.worktrees.get(id).catch(() => undefined))) continue
			let result: unknown
			try {
				result = await deps.worktrees.remove(id, discard, () => deps.stopThread(id))
			} catch (error) {
				return { deleted: false, blocked: removalStopped(id, byId, message(error), removed), preview }
			}
			const warning = (result as { warning?: string } | undefined)?.warning
			if (warning) return { deleted: false, blocked: removalStopped(id, byId, warning, removed), preview }
			removed += 1
		}
		// The task goes first: a window showing one of its threads then lands home, not on a task that's about to go.
		// If it can't go, its threads stay too.
		try {
			await deps.deleteGroup(groupId)
		} catch (error) {
			return { deleted: false, blocked: `Couldn’t delete the task (${message(error)}).${alreadyRemoved(removed)}` }
		}
		if (ids.size) await deps.deleteThreads([...ids])
		return { deleted: true }
	} finally {
		for (const release of releases) release()
	}
}

const alreadyRemoved = (removed: number) =>
	removed
		? ` No thread was deleted; ${removed === 1 ? "1 worktree was" : `${removed} worktrees were`} already removed.`
		: " Nothing was deleted."

/** Why the delete stopped at a worktree, and what it already did. */
function removalStopped(id: string, byId: ReadonlyMap<string, HistoryItem>, reason: string, removed: number): string {
	const item = byId.get(id)
	const title = item ? threadTitle(item.isSubagent ? (byId.get(rootThreadId(item, byId) ?? "") ?? item) : item) : "a thread"
	return `“${title}” worktree: ${reason.trim()}${alreadyRemoved(removed)}`
}

function quoteList(threads: readonly { title: string }[]): string {
	const names = threads.map((thread) => (thread.title === "the task worktree" ? thread.title : `“${thread.title}”`))
	const text = names.length <= 2 ? names.join(" and ") : `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`
	return text.charAt(0).toUpperCase() + text.slice(1)
}
