import { describe, expect, it, vi } from "vitest"
import { applyNotebookChanges } from "@/core/controller/taskGroup/applyNotebookChanges"
import { createNote } from "@/core/controller/taskGroup/createNote"
import { createTaskGroup } from "@/core/controller/taskGroup/createTaskGroup"
import { deleteTaskGroup } from "@/core/controller/taskGroup/deleteTaskGroup"
import { discardNotebookChanges } from "@/core/controller/taskGroup/discardNotebookChanges"
import { getTaskGroup } from "@/core/controller/taskGroup/getTaskGroup"
import { openNote } from "@/core/controller/taskGroup/openNote"
import { setThreadTaskGroup } from "@/core/controller/taskGroup/setThreadTaskGroup"
import { updateTaskGroup } from "@/core/controller/taskGroup/updateTaskGroup"

const invalid = ["..", "/", "\\", "/tmp/absolute", "C:\\absolute", ""]

describe("task group RPC validation", () => {
	it.each(invalid)("rejects unsafe identifiers %j before controller calls", async (value) => {
		const controller = {
			applyNotebookChanges: vi.fn(),
			createNote: vi.fn(),
			createTaskGroup: vi.fn(),
			deleteTaskGroup: vi.fn(),
			discardNotebookChanges: vi.fn(),
			getTaskGroup: vi.fn(),
			openNote: vi.fn(),
			setThreadTaskGroup: vi.fn(),
			updateTaskGroup: vi.fn(),
		}
		const cases = [
			[deleteTaskGroup, { id: value }],
			[getTaskGroup, { id: value }],
			[updateTaskGroup, { id: value }],
			[createTaskGroup, { title: "Task", tags: [], threadId: value }],
			[createNote, { taskGroupId: value, name: "Plan", description: "" }],
			[openNote, { taskGroupId: value, slug: "plan" }],
			[openNote, { taskGroupId: "group", slug: value }],
			[setThreadTaskGroup, { threadId: value, taskGroupId: "group" }],
			[applyNotebookChanges, { threadId: value, taskGroupId: "group", revision: "r1", items: [] }],
			[applyNotebookChanges, { threadId: "thread", taskGroupId: value, revision: "r1", items: [] }],
			[
				applyNotebookChanges,
				{ threadId: "thread", taskGroupId: "group", revision: "r1", items: [{ slug: value, include: true }] },
			],
			[discardNotebookChanges, { threadId: value, taskGroupId: "group", revision: "r1" }],
			[discardNotebookChanges, { threadId: "thread", taskGroupId: value, revision: "r1" }],
		] as const
		for (const [handler, request] of cases)
			await expect(handler(controller as never, request as never)).rejects.toThrow("Invalid")
		if (value)
			await expect(
				setThreadTaskGroup(controller as never, { threadId: "thread", taskGroupId: value } as never),
			).rejects.toThrow("Invalid")
		for (const handler of Object.values(controller)) expect(handler).not.toHaveBeenCalled()
	})

	it("permits an empty membership to unfile and forwards exact review addresses", async () => {
		const controller = { setThreadTaskGroup: vi.fn(), applyNotebookChanges: vi.fn(), discardNotebookChanges: vi.fn() }
		await setThreadTaskGroup(controller as never, { threadId: "thread", taskGroupId: "" } as never)
		expect(controller.setThreadTaskGroup).toHaveBeenCalledWith("thread", "")
		await applyNotebookChanges(
			controller as never,
			{ threadId: "thread", taskGroupId: "group", revision: "r1", items: [] } as never,
		)
		expect(controller.applyNotebookChanges).toHaveBeenCalledWith("thread", "group", "r1", [])
		await discardNotebookChanges(controller as never, { threadId: "thread", taskGroupId: "group", revision: "r2" } as never)
		expect(controller.discardNotebookChanges).toHaveBeenCalledWith("thread", "group", "r2")
	})

	it("forwards the branch-suggestion dismissal on updateTaskGroup", async () => {
		const controller = {
			updateTaskGroup: vi.fn().mockResolvedValue({
				id: "group",
				title: "T",
				tags: [],
				createdAt: 0,
				updatedAt: 0,
				noteCount: 0,
				branchSuggestionDismissed: true,
			}),
		}
		const result = await updateTaskGroup(controller as never, { id: "group", branchSuggestionDismissed: true } as never)
		expect(controller.updateTaskGroup).toHaveBeenCalledWith("group", {
			title: undefined,
			tags: undefined,
			branchSuggestionDismissed: true,
		})
		expect(result.branchSuggestionDismissed).toBe(true)
	})
})
