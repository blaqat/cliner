import type { HistoryItem } from "@shared/HistoryItem"
import type { ThreadWorktree, WorktreeSummary } from "@shared/thread-worktrees"
import { describe, expect, it, vi } from "vitest"
import {
	deleteTaskGroupOnly,
	deleteTaskGroupWithThreads,
	previewTaskGroupDelete,
	type TaskGroupDeleteDeps,
} from "./task-group-delete"

const item = (id: string, extra: Partial<HistoryItem> = {}): HistoryItem =>
	({ id, ts: 1, task: `Task ${id}`, tokensIn: 0, tokensOut: 0, totalCost: 0, ...extra }) as HistoryItem

const summary = (loseOnRemove: number): WorktreeSummary => ({
	changedFiles: loseOnRemove,
	commits: 0,
	uncommittedFiles: loseOnRemove,
	uncopiedFiles: loseOnRemove,
	copied: false,
	canUndo: false,
	loseOnRemove,
	workspaceDirty: false,
	takenOver: false,
})

function setup(options: {
	items: HistoryItem[]
	loaded?: string[]
	running?: string[]
	worktrees?: Record<string, number>
	busyElsewhere?: string[]
	removeWarning?: string
	/** The task's own worktree: files never copied, the ref scan's words, who uses it, a lease held elsewhere. */
	taskWorktree?: { losses?: number; refWarning?: string; users?: string[]; heldElsewhere?: boolean; removeWarning?: string }
	deleteGroupError?: string
}) {
	const taskKey = "task:g"
	const worktrees: Record<string, number> = {
		...options.worktrees,
		...(options.taskWorktree ? { [taskKey]: options.taskWorktree.losses ?? 0 } : {}),
	}
	const order: string[] = []
	// Each change to a worktree (see touch) makes its earlier removal token stale.
	const versions: Record<string, number> = {}
	const warningFor = (id: string) =>
		id === taskKey
			? (options.taskWorktree?.removeWarning ??
				options.taskWorktree?.refWarning ??
				(worktrees[id] ? "Changes were never copied here." : undefined))
			: (options.removeWarning ?? (worktrees[id] ? "Changes were never copied here." : undefined))
	const token = (id: string) => `${id}@${versions[id] ?? 0}`
	/** Like Remove: warns unless the confirmation names the state it warned about. */
	const review = (id: string, confirmation?: string) => {
		const warning = warningFor(id)
		if (!warning || confirmation === token(id)) return undefined
		return { warning: confirmation ? `The worktree changed since you reviewed removal. ${warning}` : warning }
	}
	const touch = (id: string) => {
		versions[id] = (versions[id] ?? 0) + 1
	}
	const deps: TaskGroupDeleteDeps = {
		listThreads: async () => options.items,
		isLoaded: (id) => !!options.loaded?.includes(id) || !!options.running?.includes(id),
		isRunning: (id) => !!options.running?.includes(id),
		worktrees: {
			get: async (id) =>
				id in worktrees ? ({ threadId: id, branch: `cline/${id}`, cwd: `/wt/${id}` } as ThreadWorktree) : undefined,
			summary: async (id) => summary(worktrees[id] ?? 0),
			assertIdle: async (id) => {
				if (options.busyElsewhere?.includes(id)) throw new Error("active elsewhere")
			},
			worktreeBusy: async (id) =>
				id === taskKey &&
				(!!options.taskWorktree?.heldElsewhere ||
					!!options.taskWorktree?.users?.some(
						(user) => options.running?.includes(user) || options.busyElsewhere?.includes(user),
					)),
			reviewRemoval: async (id) => {
				const warning = warningFor(id)
				return {
					...(warning ? { warning, removalConfirmation: token(id) } : {}),
					...(id === taskKey && options.taskWorktree?.refWarning ? { refs: options.taskWorktree.refWarning } : {}),
				}
			},
			remove: vi.fn(async (id: string, confirmation?: string, beforeRemove?: () => Promise<void>) => {
				if (id === taskKey) {
					if (
						options.taskWorktree?.users?.some(
							(user) =>
								options.busyElsewhere?.includes(user) ||
								(options.running?.includes(user) && !order.includes(`stop:${user}`)),
						)
					)
						throw new Error("Wait for every thread using this task worktree to finish before changing it.")
					const stopped = review(id, confirmation)
					if (stopped) return stopped
					delete worktrees[taskKey]
					order.push(`remove-worktree:${id}`)
					return { message: "Removed" }
				}
				const stopped = review(id, confirmation)
				if (stopped) return stopped
				await beforeRemove?.()
				order.push(`remove-worktree:${id}`)
				return { message: "Removed" }
			}),
		},
		usesTaskWorktree: async (id) => !!options.taskWorktree?.users?.includes(id),
		beginDeletion: vi.fn(() => () => {}),
		stopThread: vi.fn(async (id: string) => {
			order.push(`stop:${id}`)
		}),
		deleteThreads: vi.fn(async (ids: string[]) => {
			order.push(`delete:${ids.join(",")}`)
		}),
		deleteGroup: vi.fn(async (id: string) => {
			if (options.deleteGroupError) throw new Error(options.deleteGroupError)
			if (worktrees[taskKey] !== undefined) throw new Error("Remove this task’s worktree before deleting the task.")
			order.push(`group:${id}`)
		}),
	}
	return { deps, order, touch }
}

/** What the confirm sends back on "discard": the token of the preview the user saw. */
const reviewed = async (deps: TaskGroupDeleteDeps) => (await previewTaskGroupDelete("g", deps)).removalConfirmation

const users = ["plain", "busy", "aside", "sub"]

const task = [
	item("plain", { taskGroupId: "g" }),
	item("busy", { taskGroupId: "g" }),
	item("wt", { taskGroupId: "g" }),
	item("aside", { parentTaskId: "plain" }),
	item("sub", { isSubagent: true, parentTaskId: "busy" }),
	item("other", { taskGroupId: "h" }),
	item("loose"),
]

describe("previewTaskGroupDelete", () => {
	it("lists the task's threads and side threads, counting subagents on their thread", async () => {
		const { deps } = setup({ items: task, running: ["sub"], worktrees: { wt: 3 } })
		const { threads: preview, taskWorktree } = await previewTaskGroupDelete("g", deps)
		expect(taskWorktree).toBeUndefined()
		expect(preview.map((thread) => thread.id).sort()).toEqual(["aside", "busy", "plain", "wt"])
		const byId = Object.fromEntries(preview.map((thread) => [thread.id, thread]))
		expect(byId.busy).toMatchObject({ running: true, subagents: 1 })
		expect(byId.aside).toMatchObject({ aside: true })
		expect(byId.wt).toMatchObject({ hasWorktree: true, worktreeLosses: 3 })
		expect(byId.wt.worktreeNote).toBe(
			"has 3 changed files in its worktree that were never copied to your workspace. They'll be discarded.",
		)
		expect(byId.plain).toMatchObject({ running: false, hasWorktree: false, worktreeLosses: 0 })
	})

	it("words one changed file in the singular", async () => {
		const { deps } = setup({ items: task, worktrees: { wt: 1 }, taskWorktree: { losses: 1, users } })
		const { threads, taskWorktree } = await previewTaskGroupDelete("g", deps)
		expect(threads.find((thread) => thread.id === "wt")?.worktreeNote).toBe(
			"has 1 changed file in its worktree that was never copied to your workspace. It'll be discarded.",
		)
		expect(taskWorktree?.note).toBe(
			"The task worktree has 1 changed file that was never copied to your workspace. It'll be discarded.",
		)
	})

	it("marks a thread held by another window, worktree or not", async () => {
		const { deps } = setup({ items: task, busyElsewhere: ["plain"] })
		const plain = (await previewTaskGroupDelete("g", deps)).threads.find((thread) => thread.id === "plain")
		expect(plain).toMatchObject({ busyElsewhere: true, hasWorktree: false })
	})

	it("checks a thread loaded but idle here, since another window may be running it", async () => {
		const { deps } = setup({ items: task, loaded: ["plain"], busyElsewhere: ["plain"] })
		const plain = (await previewTaskGroupDelete("g", deps)).threads.find((thread) => thread.id === "plain")
		expect(plain).toMatchObject({ busyElsewhere: true, running: false })
	})

	it("marks a worktree thread held by another window", async () => {
		const { deps } = setup({ items: task, worktrees: { wt: 0 }, busyElsewhere: ["wt"] })
		const wt = (await previewTaskGroupDelete("g", deps)).threads.find((thread) => thread.id === "wt")
		expect(wt).toMatchObject({ busyElsewhere: true })
	})
})

describe("deleteTaskGroupWithThreads", () => {
	it("deletes nothing while worktree work would be lost without the user's yes", async () => {
		const { deps, order } = setup({ items: task, worktrees: { wt: 2 } })
		const result = await deleteTaskGroupWithThreads("g", false, deps)
		expect(result.deleted).toBe(false)
		expect(result.blocked).toContain("never copied")
		expect(result.preview?.threads.length).toBe(4)
		expect(order).toEqual([])
	})

	it("deletes nothing while a thread is busy in another window", async () => {
		const { deps, order } = setup({ items: task, worktrees: { wt: 0 }, busyElsewhere: ["wt"] })
		const result = await deleteTaskGroupWithThreads("g", true, deps)
		expect(result).toMatchObject({ deleted: false })
		expect(result.blocked).toContain("another window")
		expect(order).toEqual([])
	})

	it("stops running threads, removes worktrees, then deletes the task and its threads", async () => {
		const { deps, order } = setup({ items: task, running: ["busy", "sub"], worktrees: { wt: 2 } })
		const result = await deleteTaskGroupWithThreads("g", true, deps, await reviewed(deps))
		expect(result).toEqual({ deleted: true })
		expect(deps.worktrees.remove).toHaveBeenCalledWith("wt", "wt@0", expect.any(Function))
		expect(order.indexOf("stop:busy")).toBeLessThan(order.indexOf("remove-worktree:wt"))
		expect(order.indexOf("stop:sub")).toBeGreaterThanOrEqual(0)
		const deleted = order
			.find((step) => step.startsWith("delete:"))
			?.slice("delete:".length)
			.split(",")
			.sort()
		// Subagents go with their thread; other tasks and unfiled threads stay.
		expect(deleted).toEqual(["aside", "busy", "plain", "wt"])
		expect(order.indexOf("group:g")).toBeLessThan(order.findIndex((step) => step.startsWith("delete:")))
	})

	it("stops when the worktree manager warns and keeps every thread", async () => {
		const { deps, order } = setup({ items: task, worktrees: { wt: 0 }, removeWarning: "Some submodule caches hold work." })
		const result = await deleteTaskGroupWithThreads("g", false, deps)
		expect(result.deleted).toBe(false)
		expect(result.blocked).toContain("Some submodule caches hold work.")
		expect(result.blocked).toContain("Nothing was deleted")
		expect(order.some((step) => step.startsWith("delete:") || step.startsWith("group:"))).toBe(false)
	})

	it("removes nothing when a thread that was running at preview turns out to hold work", async () => {
		// The preview had no confirmation for the running thread; stopping it must not leave the task
		// worktree removed while the task and its threads stay.
		const running = ["wt"]
		const { deps, order } = setup({
			items: [item("wt", { taskGroupId: "g" }), item("plain", { taskGroupId: "g" })],
			running,
			worktrees: { wt: 2 },
			taskWorktree: { losses: 0, users: ["plain"] },
		})
		vi.mocked(deps.stopThread).mockImplementation(async (id) => {
			order.push(`stop:${id}`)
			running.splice(running.indexOf(id), 1)
		})
		const first = await deleteTaskGroupWithThreads("g", true, deps, await reviewed(deps))
		expect(first.deleted).toBe(false)
		expect(first.blocked).toContain("checked again now that it has stopped")
		expect(first.blocked).toContain("Nothing was deleted")
		expect(order.some((step) => step.startsWith("remove-worktree:"))).toBe(false)
		expect(order.some((step) => step.startsWith("group:") || step.startsWith("delete:"))).toBe(false)
		// The fresh preview it returns covers the stopped thread, so a second yes goes through.
		const second = await deleteTaskGroupWithThreads("g", true, deps, first.preview?.removalConfirmation)
		expect(second).toEqual({ deleted: true })
		expect(order).toContain("remove-worktree:task:g")
		expect(order).toContain("remove-worktree:wt")
	})

	it("deletes an empty task", async () => {
		const { deps, order } = setup({ items: [item("loose")] })
		expect(await deleteTaskGroupWithThreads("g", false, deps)).toEqual({ deleted: true })
		expect(order).toEqual(["group:g"])
	})
})

describe("with a task worktree", () => {
	const removedTaskWorktree = (deps: TaskGroupDeleteDeps) =>
		vi.mocked(deps.worktrees.remove).mock.calls.filter(([id]) => id === "task:g")

	describe("previewTaskGroupDelete", () => {
		it("lists the task worktree with what removing it loses, and marks the threads using it", async () => {
			const { deps } = setup({
				items: task,
				worktrees: { wt: 0 },
				taskWorktree: { losses: 2, refWarning: "Git work would be lost.\nlib · refs/heads/wip · abc", users },
			})
			const { threads, taskWorktree } = await previewTaskGroupDelete("g", deps)
			expect(taskWorktree).toEqual({
				branch: "cline/task:g",
				losses: 2,
				note: "The task worktree has 2 changed files that were never copied to your workspace. They'll be discarded.",
				refWarning: "Git work would be lost.\nlib · refs/heads/wip · abc",
				runningHere: [],
				busyElsewhere: false,
				elsewhere: false,
			})
			const byId = Object.fromEntries(threads.map((thread) => [thread.id, thread]))
			expect(byId.plain.usesTaskWorktree).toBe(true)
			// A subagent using it marks the thread it runs under.
			expect(byId.busy.usesTaskWorktree).toBe(true)
			expect(byId.wt.usesTaskWorktree).toBe(false)
		})

		it("names threads running in it here and doesn't count its files while they run", async () => {
			const { deps } = setup({ items: task, running: ["plain"], taskWorktree: { losses: 3, users } })
			const { taskWorktree } = await previewTaskGroupDelete("g", deps)
			expect(taskWorktree).toMatchObject({ runningHere: ["Task plain"], busyElsewhere: false, losses: 0 })
		})

		it("marks it busy when a thread using it runs in another window, or another session holds it", async () => {
			const elsewhere = setup({ items: task, busyElsewhere: ["plain"], taskWorktree: { users } })
			expect((await previewTaskGroupDelete("g", elsewhere.deps)).taskWorktree?.busyElsewhere).toBe(true)
			const held = setup({ items: task, taskWorktree: { users, heldElsewhere: true } })
			expect((await previewTaskGroupDelete("g", held.deps)).taskWorktree?.busyElsewhere).toBe(true)
		})
	})

	describe("deleteTaskGroupWithThreads", () => {
		it("removes a clean task worktree before the threads' own worktrees, then deletes the task and threads", async () => {
			const { deps, order } = setup({ items: task, running: ["plain"], worktrees: { wt: 0 }, taskWorktree: { users } })
			expect(await deleteTaskGroupWithThreads("g", false, deps)).toEqual({ deleted: true })
			expect(removedTaskWorktree(deps)).toEqual([["task:g", undefined]])
			expect(order.indexOf("stop:plain")).toBeLessThan(order.indexOf("remove-worktree:task:g"))
			expect(order.indexOf("remove-worktree:task:g")).toBeLessThan(order.indexOf("remove-worktree:wt"))
			expect(order.indexOf("remove-worktree:wt")).toBeLessThan(order.indexOf("group:g"))
			expect(order.at(-1)).toMatch(/^delete:/)
		})

		it("deletes nothing while the task worktree has uncopied files, then discards them on the user's yes", async () => {
			const { deps, order } = setup({ items: task, taskWorktree: { losses: 2, users } })
			const result = await deleteTaskGroupWithThreads("g", false, deps)
			expect(result).toMatchObject({ deleted: false })
			expect(result.blocked).toBe("The task worktree has work that was never copied to your workspace.")
			expect(result.preview?.taskWorktree?.losses).toBe(2)
			expect(order).toEqual([])
			expect(await deleteTaskGroupWithThreads("g", true, deps, await reviewed(deps))).toEqual({ deleted: true })
			expect(removedTaskWorktree(deps)).toEqual([["task:g", "task:g@0"]])
		})

		it("discards nothing on a stale confirm: a worktree changed since the preview gets a fresh look", async () => {
			const { deps, order, touch } = setup({ items: task, worktrees: { wt: 1 }, taskWorktree: { losses: 2, users } })
			const seen = await reviewed(deps)
			// Another window replaced the task worktree (or a new stash appeared) after the user looked.
			touch("task:g")
			const stale = await deleteTaskGroupWithThreads("g", true, deps, seen)
			expect(stale).toMatchObject({ deleted: false, blocked: expect.stringContaining("changed since you reviewed") })
			expect(order).toEqual([])
			expect(deps.worktrees.remove).not.toHaveBeenCalled()
			expect(stale.preview?.removalConfirmation).not.toBe(seen)
			expect(await deleteTaskGroupWithThreads("g", true, deps, stale.preview?.removalConfirmation)).toEqual({
				deleted: true,
			})
			expect(removedTaskWorktree(deps)).toEqual([["task:g", "task:g@1"]])
		})

		it("passes each removal the fresh token it checked, so a change during the delete still stops it", async () => {
			const running = ["plain"]
			const { deps, order, touch } = setup({ items: task, running, taskWorktree: { losses: 2, users } })
			// Stopping a thread that runs in the task worktree writes one last file.
			vi.mocked(deps.stopThread).mockImplementation(async (id) => {
				order.push(`stop:${id}`)
				if (id === "plain") {
					running.splice(0)
					touch("task:g")
				}
			})
			const preview = await previewTaskGroupDelete("g", deps)
			// Its files change while the thread runs: the preview binds nothing for it.
			expect(preview.removalConfirmation).toBe("")
			const result = await deleteTaskGroupWithThreads("g", true, deps, preview.removalConfirmation)
			expect(result.deleted).toBe(false)
			expect(result.blocked).toBe(
				"Task worktree: It was busy when you reviewed this delete, so it's checked again now that it has stopped. Changes were never copied here. Nothing was deleted.",
			)
			// Checked before any removal, so nothing was even attempted.
			expect(removedTaskWorktree(deps)).toEqual([])
			// The fresh preview, taken once the thread stopped, confirms what's there now.
			expect(await deleteTaskGroupWithThreads("g", true, deps, result.preview?.removalConfirmation)).toEqual({
				deleted: true,
			})
			expect(removedTaskWorktree(deps).at(-1)).toEqual(["task:g", "task:g@1"])
		})

		it("treats the ref scan's warning as work to discard", async () => {
			const { deps, order } = setup({ items: task, taskWorktree: { refWarning: "Git work would be lost.", users } })
			expect((await deleteTaskGroupWithThreads("g", false, deps)).blocked).toContain("never copied")
			expect(order).toEqual([])
		})

		it("stops with nothing deleted when the removal itself warns", async () => {
			const { deps, order } = setup({
				items: task,
				worktrees: { wt: 0 },
				taskWorktree: { users, removeWarning: "Changes were never copied here." },
			})
			const result = await deleteTaskGroupWithThreads("g", false, deps)
			expect(result.deleted).toBe(false)
			expect(result.blocked).toBe("Task worktree: Changes were never copied here. Nothing was deleted.")
			// Its own worktree wasn't touched either.
			expect(
				order.some(
					(step) => step.startsWith("remove-worktree") || step.startsWith("group:") || step.startsWith("delete:"),
				),
			).toBe(false)
		})

		it("deletes nothing from a window on another workspace, either way", async () => {
			const { deps, order } = setup({ items: task, taskWorktree: { users } })
			deps.taskWorktreeElsewhere = async () => true
			const preview = await previewTaskGroupDelete("g", deps)
			expect(preview.taskWorktree?.elsewhere).toBe(true)
			for (const result of [
				await deleteTaskGroupWithThreads("g", true, deps, preview.removalConfirmation),
				await deleteTaskGroupOnly("g", true, deps, preview.removalConfirmation),
			]) {
				expect(result.deleted).toBe(false)
				expect(result.blocked).toContain("belongs to another workspace")
			}
			expect(order).toEqual([])
		})

		it("deletes nothing while a thread using it runs in another window", async () => {
			const { deps, order } = setup({ items: task, taskWorktree: { users, heldElsewhere: true } })
			const result = await deleteTaskGroupWithThreads("g", true, deps)
			expect(result.blocked).toBe("A thread using the task worktree is running in another window. Stop it there first.")
			expect(order).toEqual([])
		})

		it("keeps the threads when the task itself can't be deleted afterwards", async () => {
			const { deps, order } = setup({ items: task, taskWorktree: { users }, deleteGroupError: "disk full" })
			const result = await deleteTaskGroupWithThreads("g", false, deps)
			expect(result.deleted).toBe(false)
			expect(result.blocked).toBe(
				"Couldn’t delete the task (disk full). No thread was deleted; 1 worktree was already removed.",
			)
			expect(order.some((step) => step.startsWith("delete:"))).toBe(false)
		})
	})

	describe("deleteTaskGroupOnly", () => {
		it("deletes a task without a worktree straight away", async () => {
			const { deps, order } = setup({ items: task })
			expect(await deleteTaskGroupOnly("g", false, deps)).toEqual({ deleted: true })
			expect(order).toEqual(["group:g"])
		})

		it("removes a clean task worktree first, then deletes just the task; threads stay", async () => {
			const { deps, order } = setup({ items: task, taskWorktree: { users } })
			expect(await deleteTaskGroupOnly("g", false, deps)).toEqual({ deleted: true })
			expect(order).toEqual(["remove-worktree:task:g", "group:g"])
			expect(deps.stopThread).not.toHaveBeenCalled()
			expect(deps.deleteThreads).not.toHaveBeenCalled()
		})

		it("asks before discarding uncopied files or Git work, then discards on yes", async () => {
			const dirty = setup({ items: task, taskWorktree: { losses: 1, users } })
			const result = await deleteTaskGroupOnly("g", false, dirty.deps)
			expect(result).toMatchObject({
				deleted: false,
				blocked: "The task worktree has work that was never copied to your workspace.",
			})
			expect(dirty.order).toEqual([])
			expect(await deleteTaskGroupOnly("g", true, dirty.deps, await reviewed(dirty.deps))).toEqual({ deleted: true })
			expect(dirty.order).toEqual(["remove-worktree:task:g", "group:g"])

			const refs = setup({ items: task, taskWorktree: { refWarning: "Git work would be lost.", users } })
			expect((await deleteTaskGroupOnly("g", false, refs.deps)).deleted).toBe(false)
			expect(refs.order).toEqual([])
		})

		it("never stops a kept thread: one running in it here blocks the delete", async () => {
			const { deps, order } = setup({ items: task, running: ["plain"], taskWorktree: { users } })
			const result = await deleteTaskGroupOnly("g", true, deps)
			expect(result.blocked).toBe("“Task plain” is running in the task worktree. Stop it or wait for it to finish first.")
			expect(deps.stopThread).not.toHaveBeenCalled()
			expect(order).toEqual([])
		})

		it("deletes nothing while a thread using it runs in another window", async () => {
			const { deps, order } = setup({ items: task, busyElsewhere: ["aside"], taskWorktree: { users } })
			const result = await deleteTaskGroupOnly("g", true, deps)
			expect(result.blocked).toBe("A thread using the task worktree is running in another window. Stop it there first.")
			expect(order).toEqual([])
		})

		it("ignores threads busy elsewhere that don't use it: they're kept", async () => {
			const { deps } = setup({ items: task, busyElsewhere: ["wt"], worktrees: { wt: 0 }, taskWorktree: { users } })
			expect(await deleteTaskGroupOnly("g", false, deps)).toEqual({ deleted: true })
		})

		it("keeps the task on a stale confirm", async () => {
			const { deps, order, touch } = setup({ items: task, taskWorktree: { losses: 1, users } })
			const seen = await reviewed(deps)
			touch("task:g")
			const result = await deleteTaskGroupOnly("g", true, deps, seen)
			expect(result.blocked).toContain("changed since you reviewed")
			expect(order).toEqual([])
			expect(await deleteTaskGroupOnly("g", true, deps, result.preview?.removalConfirmation)).toEqual({ deleted: true })
		})

		it("keeps the task when the removal warns", async () => {
			const { deps, order } = setup({
				items: task,
				taskWorktree: { users, removeWarning: "Changes were never copied here." },
			})
			const result = await deleteTaskGroupOnly("g", false, deps)
			expect(result.blocked).toBe("Task worktree: Changes were never copied here. Nothing was deleted.")
			expect(result.preview?.taskWorktree).toBeDefined()
			expect(order).toEqual([])
		})
	})
})
