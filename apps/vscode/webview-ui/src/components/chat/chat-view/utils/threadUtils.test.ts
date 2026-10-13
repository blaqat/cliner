import type { ClineMessage } from "@shared/ExtensionMessage"
import type { HistoryItem } from "@shared/HistoryItem"
import { describe, expect, it } from "vitest"
import {
	buildSubagentLineage,
	buildThreadItems,
	buildThreadPath,
	collectSubagents,
	isStoppable,
	needsAttention,
	threadTitle,
} from "./threadUtils"

function item(id: string, ts: number, extra: Partial<HistoryItem> = {}): HistoryItem {
	return { id, ts, task: `task ${id}`, tokensIn: 0, tokensOut: 0, totalCost: 0, ...extra }
}

const spawn = (ts: number, prompts: string[], access?: ("read" | "write")[]): ClineMessage => ({
	ts,
	type: "say",
	say: "use_subagents",
	text: JSON.stringify({ prompts, access }),
})

const status = (ts: number, items: { index: number; prompt: string; status: string; access?: string }[]): ClineMessage => ({
	ts,
	type: "say",
	say: "subagent",
	text: JSON.stringify({ status: "running", total: items.length, items }),
})

describe("collectSubagents", () => {
	it("uses live status rows and falls back to the spawn's access levels", () => {
		const messages = [
			spawn(10, ["read the code", "fix the bug"], ["read", "write"]),
			status(11, [
				{ index: 1, prompt: "read the code", status: "completed" },
				{ index: 2, prompt: "fix the bug", status: "running" },
			]),
		]

		expect(collectSubagents(messages)).toEqual([
			{
				kind: "subagent",
				id: "11:1",
				title: "read the code",
				status: "done",
				current: false,
				previewOnly: true,
				access: "read",
			},
			{
				kind: "subagent",
				id: "11:2",
				title: "fix the bug",
				status: "running",
				current: false,
				previewOnly: true,
				access: "write",
			},
		])
	})

	it("shows spawns without a status row yet as waiting", () => {
		const items = collectSubagents([spawn(10, ["explore"], ["write"])])
		expect(items).toEqual([
			{
				kind: "subagent",
				id: "10:1",
				title: "explore",
				status: "waiting",
				current: false,
				previewOnly: true,
				access: "write",
			},
		])
	})

	it("prefers the access on the status item", () => {
		const items = collectSubagents([status(5, [{ index: 1, prompt: "p", status: "failed", access: "write" }])])
		expect(items[0]).toMatchObject({ status: "error", access: "write" })
	})

	it("maps user-stopped subagents to a terminal chip status", () => {
		const items = collectSubagents([
			status(5, [
				{ index: 1, prompt: "a", status: "stopped" },
				{ index: 2, prompt: "b", status: "running" },
			]),
		])
		expect(items[0].status).toBe("error")
		expect(items[1].status).toBe("running")
	})
})

describe("buildThreadItems", () => {
	const history = [
		item("root", 100),
		item("aside-2", 300, { parentTaskId: "root", task: "Aside: second" }),
		item("aside-1", 200, { parentTaskId: "root", task: "Aside: first" }),
		item("other", 400),
	]

	it("returns nothing when the chat has no asides", () => {
		expect(buildThreadItems(history[3], history, {})).toEqual([])
		expect(buildThreadItems(undefined, history, {})).toEqual([])
	})

	it("lists Main then asides oldest first, and never subagents", () => {
		const child = item("child", 150, { isSubagent: true, parentTaskId: "root" })
		const items = buildThreadItems(history[0], [...history, child], { "aside-1": "running" })

		expect(items.map((it) => [it.kind, it.id, it.title, it.current])).toEqual([
			["main", "root", "Main", true],
			["aside", "aside-1", "first", false],
			["aside", "aside-2", "second", false],
		])
		expect(items[1].status).toBe("running")
	})

	it("is empty for a chat whose only children are subagents, and inside a subagent thread", () => {
		const root = item("solo", 1)
		const child = item("solo__a", 2, { isSubagent: true, parentTaskId: "solo" })
		expect(buildThreadItems(root, [root, child], {})).toEqual([])
		expect(buildThreadItems(child, [root, child], {})).toEqual([])
	})

	it("roots the strip at the parent when an aside is focused", () => {
		const items = buildThreadItems(history[1], history, {})
		expect(items[0]).toMatchObject({ kind: "main", id: "root", current: false })
		expect(items.find((it) => it.id === "aside-2")?.current).toBe(true)
	})

	it("keeps a chip for a focused aside missing from history", () => {
		const focused = item("fresh", 500, { parentTaskId: "root", task: "Aside: fresh" })
		const items = buildThreadItems(focused, history, {})
		expect(items.at(-1)).toMatchObject({ kind: "aside", id: "fresh", title: "fresh", current: true })
	})

	it("hides closed chips but never the focused one", () => {
		const hidden = new Set(["aside-1", "aside-2"])
		expect(buildThreadItems(history[0], history, {}, hidden)).toEqual([])
		const focusedAside = buildThreadItems(history[1], history, {}, hidden)
		expect(focusedAside.map((it) => it.id)).toEqual(["root", "aside-2"])
	})
})

describe("buildSubagentLineage", () => {
	const root = item("root", 1, { task: "Refactor auth" })
	const a = item("a", 2, { isSubagent: true, parentTaskId: "root", task: "explore-auth", subagentAccess: "read" })
	const sibling = item("sibling", 3, { isSubagent: true, parentTaskId: "root", task: "sibling" })
	const b = item("b", 4, { isSubagent: true, parentTaskId: "a", task: "patch-cookie", subagentAccess: "write" })
	const grandchild = item("c", 5, { isSubagent: true, parentTaskId: "b", task: "grandchild" })
	const history = [root, a, sibling, b, grandchild]

	it("includes cache reads and writes once in child totals", () => {
		const child = { ...a, tokensIn: 100, tokensOut: 20, cacheReads: 850, cacheWrites: 50, totalCost: 0.002 }
		const lineage = buildSubagentLineage(root, [root, child], {}, [])
		expect(lineage?.children[0]).toMatchObject({ tokens: 1020, cost: 0.002 })
	})

	it("shows the root with its direct children only (no grandchildren)", () => {
		const lineage = buildSubagentLineage(root, history, { a: "running" }, [])
		expect(lineage?.parent).toBeUndefined()
		expect(lineage?.current).toMatchObject({ id: "root", title: "Refactor auth" })
		expect(lineage?.children.map((row) => [row.id, row.status, row.access, row.parentTaskId])).toEqual([
			["a", "running", "read", "root"],
			["sibling", "done", "read", "root"],
		])
	})

	it("shows a subagent's immediate parent, itself and its children; no grandparent, siblings or grandchildren", () => {
		const lineage = buildSubagentLineage(a, history, { b: "waiting" }, [])
		expect(lineage?.parent).toMatchObject({ id: "root", title: "Refactor auth" })
		expect(lineage?.current).toMatchObject({ id: "a", access: "read" })
		expect(lineage?.children.map((row) => row.id)).toEqual(["b"])
		expect(needsAttention(lineage!.children[0])).toBe(true)

		const nested = buildSubagentLineage(b, history, {}, [])
		expect(nested?.parent).toMatchObject({ id: "a", title: "explore-auth", access: "read" })
		expect(nested?.children.map((row) => row.id)).toEqual(["c"])
	})

	it("falls back to the subagent view's parent id and a placeholder title", () => {
		const orphan = item("x", 9, { isSubagent: true, task: "orphan" })
		expect(buildSubagentLineage(orphan, [orphan], {}, [], "gone")?.parent).toMatchObject({ id: "gone", title: "Parent" })
	})

	it("adds unsaved transcript children without duplicating saved ones", () => {
		const messages: ClineMessage[] = [
			{
				ts: 5,
				type: "say",
				say: "subagent",
				text: JSON.stringify({ items: [{ index: 1, prompt: "live child", status: "running", childSessionId: "live" }] }),
			},
			spawn(10, ["explore-auth", "new one"], ["read", "write"]),
		]
		const lineage = buildSubagentLineage(root, [root, a], {}, messages)
		expect(lineage?.children.map((row) => [row.id, row.previewOnly ?? false])).toEqual([
			["a", false],
			["live", false],
			["10:2", true],
		])
		expect(lineage?.children.map(isStoppable)).toEqual([false, true, true])
		expect(needsAttention(lineage!.children[1])).toBe(false)
	})

	it("is undefined without a focused task", () => {
		expect(buildSubagentLineage(undefined, history, {}, [])).toBeUndefined()
	})
})

describe("buildThreadPath", () => {
	const root = item("root", 1, { task: "Implement steps 1–2", taskGroupId: "g1" })
	// Asides own their membership (copied from the parent when forked).
	const aside = item("aside", 2, { task: "Aside: Fix migration test", parentTaskId: "root", taskGroupId: "g1" })
	const agent = item("agent", 3, { task: "explore schema", parentTaskId: "aside", isSubagent: true })

	it("walks asides and subagents up to the root, root first", () => {
		expect(buildThreadPath(agent, [root, aside, agent])).toEqual({
			taskGroupId: "g1",
			threads: [
				{ id: "root", title: "Implement steps 1–2", sub: false },
				{ id: "aside", title: "Fix migration test", sub: true },
				{ id: "agent", title: "explore schema", sub: true },
			],
		})
	})

	it("uses an aside's own task, not its parent's", () => {
		const moved = { ...aside, taskGroupId: "g2" }
		expect(buildThreadPath(moved, [root, moved]).taskGroupId).toBe("g2")
		const unfiled = { ...aside, taskGroupId: undefined }
		expect(buildThreadPath(unfiled, [root, unfiled]).taskGroupId).toBeUndefined()
	})

	it("gives a subagent the task of the nearest non-subagent above it", () => {
		const moved = { ...aside, taskGroupId: "g2" }
		const nested = item("nested", 4, { task: "dig deeper", parentTaskId: "agent", isSubagent: true })
		expect(buildThreadPath(agent, [root, moved, agent]).taskGroupId).toBe("g2")
		expect(buildThreadPath(nested, [root, moved, agent, nested]).taskGroupId).toBe("g2")
		const rootAgent = item("ra", 5, { task: "scan", parentTaskId: "root", isSubagent: true })
		expect(buildThreadPath(rootAgent, [root, rootAgent]).taskGroupId).toBe("g1")
	})

	it("prefers user-set titles", () => {
		const titled = { ...root, title: "Steps 1–2" }
		expect(buildThreadPath(aside, [titled, aside]).threads[0].title).toBe("Steps 1–2")
		expect(threadTitle({ ...aside, title: "Migration" })).toBe("Migration")
		expect(threadTitle({ ...aside, title: "  " })).toBe("Fix migration test")
	})

	it("keeps a placeholder for a parent missing from history and stops there", () => {
		expect(buildThreadPath(aside, [aside])).toEqual({
			taskGroupId: "g1",
			threads: [
				{ id: "root", title: "Parent", sub: false },
				{ id: "aside", title: "Fix migration test", sub: true },
			],
		})
	})

	it("is a single level for a top-level thread, and empty without one", () => {
		expect(buildThreadPath(root, [root]).threads).toHaveLength(1)
		expect(buildThreadPath(undefined, [root])).toEqual({ threads: [] })
	})

	it("survives a parent cycle", () => {
		const a = item("a", 1, { parentTaskId: "b" })
		const b = item("b", 2, { parentTaskId: "a" })
		expect(buildThreadPath(a, [a, b]).threads.map((thread) => thread.id)).toEqual(["b", "a"])
	})
})
