import type { HistoryItem } from "@shared/HistoryItem"
import type { TaskGroupSummary, TaskTag } from "@shared/task-groups"
import { describe, expect, it } from "vitest"
import { effectiveThreadTags } from "./effectiveThreadTags"

const tag = (kind: TaskTag["kind"], value: string): TaskTag => ({ kind, value, source: "user" })
const group = (id: string, tags: TaskTag[]): TaskGroupSummary => ({
	id,
	title: `Task ${id}`,
	tags,
	createdAt: 0,
	updatedAt: 0,
	noteCount: 0,
})
const item = (id: string, extra: Partial<HistoryItem> = {}): HistoryItem => ({
	id,
	ts: 1,
	task: id,
	tokensIn: 0,
	tokensOut: 0,
	totalCost: 0,
	...extra,
})

describe("effectiveThreadTags", () => {
	const groups = [group("g", [tag("ticket", "PROJ-1"), tag("label", "Shared")])]

	it("lists own tags first, then the task's marked inherited with the task title", () => {
		const thread = item("t", { taskGroupId: "g", tags: [tag("label", "mine")] })

		expect(effectiveThreadTags(thread, [thread], groups)).toEqual([
			{ tag: tag("label", "mine"), inherited: false },
			{ tag: tag("ticket", "PROJ-1"), inherited: true, taskTitle: "Task g" },
			{ tag: tag("label", "Shared"), inherited: true, taskTitle: "Task g" },
		])
	})

	it("lists a tag held by both once, as the thread's own (case-insensitive)", () => {
		const thread = item("t", { taskGroupId: "g", tags: [tag("label", "shared")] })

		const result = effectiveThreadTags(thread, [thread], groups)

		expect(result.map((entry) => [entry.tag.value, entry.inherited])).toEqual([
			["shared", false],
			["PROJ-1", true],
		])
	})

	it("does not merge tags of different kinds", () => {
		const thread = item("t", { taskGroupId: "g", tags: [tag("branch", "PROJ-1")] })

		expect(effectiveThreadTags(thread, [thread], groups)).toHaveLength(3)
	})

	it("returns only own tags for an unfiled thread or an unknown task", () => {
		const own = [tag("label", "mine")]

		expect(effectiveThreadTags(item("a", { tags: own }), [], groups).map((e) => e.inherited)).toEqual([false])
		expect(effectiveThreadTags(item("b", { taskGroupId: "gone", tags: own }), [], groups)).toHaveLength(1)
		expect(effectiveThreadTags(item("c"), [], undefined)).toEqual([])
	})

	it("resolves a subagent's task through its nearest non-subagent ancestor", () => {
		const root = item("root", { taskGroupId: "g" })
		const sub = item("sub", { isSubagent: true, parentTaskId: "root" })

		expect(effectiveThreadTags(sub, [root, sub], groups).map((e) => e.tag.value)).toEqual(["PROJ-1", "Shared"])
	})
})
