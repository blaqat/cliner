import type { HistoryItem } from "@shared/HistoryItem"
import { describe, expect, it } from "vitest"
import {
	asideDescendantIds,
	asideRootId,
	effectiveTaskGroupId,
	resolveEffectiveTaskGroupId,
	withEffectiveTaskGroups,
} from "./effective-task-group"
import { resolveNotebookOwner } from "./notebook-context"

const thread = (id: string, extra: Partial<HistoryItem> = {}): HistoryItem =>
	({ id, ts: 1, task: id, tokensIn: 0, tokensOut: 0, totalCost: 0, ...extra }) as HistoryItem
const index = (...items: HistoryItem[]) => new Map(items.map((item) => [item.id, item]))

describe("effective task group", () => {
	it("an aside takes its parent's task whatever it stores, through nested asides", () => {
		const byId = index(
			thread("parent", { taskGroupId: "A" }),
			thread("unfiled", { parentTaskId: "parent" }),
			thread("elsewhere", { parentTaskId: "parent", taskGroupId: "B" }),
			thread("nested", { parentTaskId: "unfiled" }),
		)
		for (const id of ["unfiled", "elsewhere", "nested"]) expect(effectiveTaskGroupId(byId.get(id)!, byId)).toBe("A")
	})

	it("a parent that is unfiled leaves its asides unfiled", () => {
		const byId = index(thread("parent"), thread("aside", { parentTaskId: "parent", taskGroupId: "B" }))
		expect(effectiveTaskGroupId(byId.get("aside")!, byId)).toBeUndefined()
	})

	it("an aside whose parent is gone keeps its own task, and a parent loop terminates", () => {
		const orphan = thread("orphan", { parentTaskId: "deleted", taskGroupId: "A" })
		expect(effectiveTaskGroupId(orphan, index(orphan))).toBe("A")
		const loop = index(thread("x", { parentTaskId: "y", taskGroupId: "A" }), thread("y", { parentTaskId: "x" }))
		expect(() => effectiveTaskGroupId(loop.get("x")!, loop)).not.toThrow()
	})

	it("subagents follow their owner, including an aside's owner chain; a missing owner means no task", () => {
		const byId = index(
			thread("root", { taskGroupId: "A" }),
			thread("aside", { parentTaskId: "root" }),
			thread("agent", { isSubagent: true, parentTaskId: "aside", runtimeOwnerTaskId: "aside" }),
			thread("lost", { isSubagent: true, parentTaskId: "gone", taskGroupId: "B" }),
		)
		expect(effectiveTaskGroupId(byId.get("agent")!, byId)).toBe("A")
		expect(effectiveTaskGroupId(byId.get("lost")!, byId)).toBeUndefined()
	})

	it("the async resolver matches the synchronous one", async () => {
		const byId = index(thread("parent", { taskGroupId: "A" }), thread("aside", { parentTaskId: "parent" }))
		expect(await resolveEffectiveTaskGroupId(byId.get("aside")!, async (id) => byId.get(id))).toBe("A")
	})

	it("withEffectiveTaskGroups rewrites asides only and keeps untouched items by identity", () => {
		const parent = thread("parent", { taskGroupId: "A" })
		const aside = thread("aside", { parentTaskId: "parent" })
		const agent = thread("agent", { isSubagent: true, parentTaskId: "parent" })
		const [p, a, s] = withEffectiveTaskGroups([parent, aside, agent])
		expect(p).toBe(parent)
		expect(a).toMatchObject({ id: "aside", taskGroupId: "A" })
		expect(s).toBe(agent)
	})

	it("finds nested asides, including asides of subagents, but never subagents", () => {
		const items = [
			thread("root"),
			thread("a1", { parentTaskId: "root" }),
			thread("a2", { parentTaskId: "a1" }),
			thread("agent", { isSubagent: true, parentTaskId: "root", runtimeOwnerTaskId: "root" }),
			thread("agentAside", { parentTaskId: "agent" }),
			thread("other"),
			thread("otherAside", { parentTaskId: "other" }),
		]
		expect(asideDescendantIds("root", items).sort()).toEqual(["a1", "a2", "agentAside"])
		expect(asideRootId("a2", index(...items))).toBe("root")
		expect(asideRootId("root", index(...items))).toBe("root")
	})

	it("notebook owner: an aside, a nested aside and a subagent all resolve to the parent's task", async () => {
		const byId = index(
			thread("root", { taskGroupId: "A" }),
			thread("legacy", { parentTaskId: "root" }),
			thread("nested", { parentTaskId: "legacy" }),
			thread("agent", { isSubagent: true, parentTaskId: "nested", runtimeOwnerTaskId: "nested" }),
		)
		const find = async (id: string) => byId.get(id)
		// Pending edits stay with the thread the user reviews them in.
		expect(await resolveNotebookOwner(byId.get("legacy")!, find)).toEqual({ rootThreadId: "legacy", taskGroupId: "A" })
		expect(await resolveNotebookOwner(byId.get("nested")!, find)).toEqual({ rootThreadId: "nested", taskGroupId: "A" })
		expect(await resolveNotebookOwner(byId.get("agent")!, find)).toEqual({ rootThreadId: "nested", taskGroupId: "A" })
		expect(await resolveNotebookOwner(byId.get("root")!, find)).toEqual({ rootThreadId: "root", taskGroupId: "A" })
	})

	it("notebook owner for a not-yet-persisted aside resolves from its start metadata", async () => {
		const parent = thread("root", { taskGroupId: "A" })
		const fresh = thread("fresh", { parentTaskId: "root" })
		expect(await resolveNotebookOwner(fresh, async (id) => (id === "root" ? parent : undefined))).toEqual({
			rootThreadId: "fresh",
			taskGroupId: "A",
		})
	})
})
