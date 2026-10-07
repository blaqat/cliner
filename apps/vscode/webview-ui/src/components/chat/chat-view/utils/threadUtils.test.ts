import type { ClineMessage } from "@shared/ExtensionMessage"
import type { HistoryItem } from "@shared/HistoryItem"
import { describe, expect, it } from "vitest"
import { buildSubagentLineage, buildThreadItems, collectSubagents, isStoppable, needsAttention } from "./threadUtils"

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
