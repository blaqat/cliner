import type { HistoryItem } from "@shared/HistoryItem"
import type { ThreadWorktree, WorktreeSummary } from "@shared/thread-worktrees"
import { describe, expect, it, vi } from "vitest"
import { deleteTaskGroupWithThreads, previewTaskGroupDelete, type TaskGroupDeleteDeps } from "./task-group-delete"

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
}) {
	const order: string[] = []
	const deps: TaskGroupDeleteDeps = {
		listThreads: async () => options.items,
		isLoaded: (id) => !!options.loaded?.includes(id) || !!options.running?.includes(id),
		isRunning: (id) => !!options.running?.includes(id),
		worktrees: {
			get: async (id) => (id in (options.worktrees ?? {}) ? ({ threadId: id } as ThreadWorktree) : undefined),
			summary: async (id) => summary(options.worktrees?.[id] ?? 0),
			assertIdle: async (id) => {
				if (options.busyElsewhere?.includes(id)) throw new Error("active elsewhere")
			},
			remove: vi.fn(async (id: string, confirmed: boolean, beforeRemove?: () => Promise<void>) => {
				if (!confirmed && options.removeWarning) return { warning: options.removeWarning }
				await beforeRemove?.()
				order.push(`remove-worktree:${id}`)
				return { message: "Removed" }
			}),
		},
		beginDeletion: vi.fn(() => () => {}),
		stopThread: vi.fn(async (id: string) => {
			order.push(`stop:${id}`)
		}),
		deleteThreads: vi.fn(async (ids: string[]) => {
			order.push(`delete:${ids.join(",")}`)
		}),
		deleteGroup: vi.fn(async (id: string) => {
			order.push(`group:${id}`)
		}),
	}
	return { deps, order }
}

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
		const preview = await previewTaskGroupDelete("g", deps)
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

	it("marks a thread held by another window, worktree or not", async () => {
		const { deps } = setup({ items: task, busyElsewhere: ["plain"] })
		const plain = (await previewTaskGroupDelete("g", deps)).find((thread) => thread.id === "plain")
		expect(plain).toMatchObject({ busyElsewhere: true, hasWorktree: false })
	})

	it("checks a thread loaded but idle here, since another window may be running it", async () => {
		const { deps } = setup({ items: task, loaded: ["plain"], busyElsewhere: ["plain"] })
		const plain = (await previewTaskGroupDelete("g", deps)).find((thread) => thread.id === "plain")
		expect(plain).toMatchObject({ busyElsewhere: true, running: false })
	})

	it("marks a worktree thread held by another window", async () => {
		const { deps } = setup({ items: task, worktrees: { wt: 0 }, busyElsewhere: ["wt"] })
		const wt = (await previewTaskGroupDelete("g", deps)).find((thread) => thread.id === "wt")
		expect(wt).toMatchObject({ busyElsewhere: true })
	})
})

describe("deleteTaskGroupWithThreads", () => {
	it("deletes nothing while worktree work would be lost without the user's yes", async () => {
		const { deps, order } = setup({ items: task, worktrees: { wt: 2 } })
		const result = await deleteTaskGroupWithThreads("g", false, deps)
		expect(result.deleted).toBe(false)
		expect(result.blocked).toContain("never copied")
		expect(result.preview?.length).toBe(4)
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
		const result = await deleteTaskGroupWithThreads("g", true, deps)
		expect(result).toEqual({ deleted: true })
		expect(deps.worktrees.remove).toHaveBeenCalledWith("wt", true, expect.any(Function))
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

	it("deletes an empty task", async () => {
		const { deps, order } = setup({ items: [item("loose")] })
		expect(await deleteTaskGroupWithThreads("g", false, deps)).toEqual({ deleted: true })
		expect(order).toEqual(["group:g"])
	})
})
