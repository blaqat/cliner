import type { TaskGroupSummary } from "@shared/task-groups"
import { describe, expect, it } from "vitest"
import { suggestBranchTask } from "./branchSuggestion"

const group = (id: string, updatedAt: number, branch?: string, extra: Partial<TaskGroupSummary> = {}): TaskGroupSummary => ({
	id,
	title: `Task ${id}`,
	tags: branch ? [{ kind: "branch", value: branch, source: "user" }] : [],
	createdAt: 0,
	updatedAt,
	noteCount: 0,
	...extra,
})

describe("suggestBranchTask", () => {
	const groups = [group("a", 1, "feat/export"), group("b", 2, "feat/other")]

	it("suggests the task carrying the current branch", () => {
		expect(suggestBranchTask({ currentBranch: "feat/export", taskGroups: groups })?.id).toBe("a")
	})

	it("matches the branch case-insensitively", () => {
		expect(suggestBranchTask({ currentBranch: "FEAT/Export", taskGroups: groups })?.id).toBe("a")
	})

	it("suggests nothing without a current branch", () => {
		expect(suggestBranchTask({ taskGroups: groups })).toBeUndefined()
		expect(suggestBranchTask({ currentBranch: "", taskGroups: groups })).toBeUndefined()
	})

	it("suggests nothing when no task has the branch (a ticket or label of the same text does not count)", () => {
		const lookalike = group("c", 3, undefined, { tags: [{ kind: "label", value: "feat/export", source: "user" }] })
		expect(suggestBranchTask({ currentBranch: "feat/none", taskGroups: groups })).toBeUndefined()
		expect(suggestBranchTask({ currentBranch: "feat/export", taskGroups: [lookalike] })).toBeUndefined()
	})

	it("suggests nothing when the composer is already in that task", () => {
		expect(suggestBranchTask({ currentBranch: "feat/export", taskGroups: groups, composerTaskGroupId: "a" })).toBeUndefined()
	})

	it("suggests nothing when the composer's task also has the branch, even if a newer one does", () => {
		const newer = [...groups, group("c", 5, "feat/export")]
		expect(suggestBranchTask({ currentBranch: "feat/export", taskGroups: newer, composerTaskGroupId: "a" })).toBeUndefined()
	})

	it("suggests moving when the composer is in a different task", () => {
		expect(suggestBranchTask({ currentBranch: "feat/export", taskGroups: groups, composerTaskGroupId: "b" })?.id).toBe("a")
	})

	it("never suggests on a task page", () => {
		expect(suggestBranchTask({ currentBranch: "feat/export", taskGroups: groups, pageTaskGroupId: "b" })).toBeUndefined()
	})

	it("skips a dismissed task but still suggests another that matches", () => {
		const both = [group("x", 5, "feat/export", { branchSuggestionDismissed: true }), group("y", 1, "feat/export")]
		expect(suggestBranchTask({ currentBranch: "feat/export", taskGroups: both })?.id).toBe("y")
		expect(suggestBranchTask({ currentBranch: "feat/export", taskGroups: [both[0]] })).toBeUndefined()
	})

	it("prefers the most recently updated task when several match", () => {
		const many = [group("old", 1, "feat/export"), group("new", 9, "feat/export"), group("mid", 5, "feat/export")]
		expect(suggestBranchTask({ currentBranch: "feat/export", taskGroups: many })?.id).toBe("new")
	})
})
