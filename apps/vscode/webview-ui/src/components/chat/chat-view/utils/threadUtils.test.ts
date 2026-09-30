import type { ClineMessage } from "@shared/ExtensionMessage"
import type { HistoryItem } from "@shared/HistoryItem"
import { describe, expect, it } from "vitest"
import { buildThreadItems, collectSubagents } from "./threadUtils"

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
			{ kind: "subagent", id: "11:1", title: "read the code", status: "done", current: false, access: "read" },
			{ kind: "subagent", id: "11:2", title: "fix the bug", status: "running", current: false, access: "write" },
		])
	})

	it("shows spawns without a status row yet as waiting", () => {
		const items = collectSubagents([spawn(10, ["explore"], ["write"])])
		expect(items).toEqual([
			{ kind: "subagent", id: "10:1", title: "explore", status: "waiting", current: false, access: "write" },
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

	it("returns nothing when the chat has no asides or subagents", () => {
		expect(buildThreadItems(history[3], history, {}, [])).toEqual([])
		expect(buildThreadItems(undefined, history, {}, [])).toEqual([])
	})

	it("lists Main, then asides oldest first, then subagents", () => {
		const items = buildThreadItems(history[0], history, { "aside-1": "running" }, [spawn(1, ["scan"])])

		expect(items.map((it) => [it.kind, it.id, it.title, it.current])).toEqual([
			["main", "root", "Main", true],
			["aside", "aside-1", "first", false],
			["aside", "aside-2", "second", false],
			["subagent", "1:1", "scan", false],
		])
		expect(items[1].status).toBe("running")
	})

	it("roots the strip at the parent when an aside is focused", () => {
		const items = buildThreadItems(history[1], history, {}, [])
		expect(items[0]).toMatchObject({ kind: "main", id: "root", current: false })
		expect(items.find((it) => it.id === "aside-2")?.current).toBe(true)
	})

	it("keeps a chip for a focused aside missing from history", () => {
		const focused = item("fresh", 500, { parentTaskId: "root", task: "Aside: fresh" })
		const items = buildThreadItems(focused, history, {}, [])
		expect(items.at(-1)).toMatchObject({ kind: "aside", id: "fresh", title: "fresh", current: true })
	})

	it("hides closed chips but never the focused one", () => {
		const hidden = new Set(["aside-1", "aside-2", "1:1"])
		expect(buildThreadItems(history[0], history, {}, [spawn(1, ["scan"])], hidden)).toEqual([])
		const focusedAside = buildThreadItems(history[1], history, {}, [], hidden)
		expect(focusedAside.map((it) => it.id)).toEqual(["root", "aside-2"])
	})

	it("ignores subagents inherited from the parent's transcript in an aside", () => {
		const focused = item("aside-3", 600, { parentTaskId: "root", forkedAtTs: 50 })
		const items = buildThreadItems(focused, [...history, focused], {}, [spawn(10, ["inherited"]), spawn(60, ["own"])])
		expect(items.filter((it) => it.kind === "subagent").map((it) => it.title)).toEqual(["own"])
	})
})
