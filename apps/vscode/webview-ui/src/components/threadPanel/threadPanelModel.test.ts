import type { ClineMessage } from "@shared/ExtensionMessage"
import type { HistoryItem } from "@shared/HistoryItem"
import { describe, expect, it } from "vitest"
import { type AgentRow, buildAgentRows, changedFiles, shortTokens, splitAgentRows } from "./threadPanelModel"

const item = (id: string, fields: Partial<HistoryItem> = {}): HistoryItem => ({
	id,
	ts: 1,
	task: id,
	tokensIn: 0,
	tokensOut: 0,
	totalCost: 0,
	...fields,
})

const tool = (ts: number, payload: object, fields: Partial<ClineMessage> = {}): ClineMessage => ({
	ts,
	type: "say",
	say: "tool",
	text: JSON.stringify(payload),
	...fields,
})

describe("changedFiles", () => {
	it("counts each edited, created or deleted file once, and skips reads and streaming rows", () => {
		expect(
			changedFiles([
				tool(1, { tool: "editedExistingFile", path: "a.ts" }),
				tool(2, { tool: "editedExistingFile", path: "a.ts" }),
				tool(3, { tool: "newFileCreated", path: "b.ts" }),
				tool(4, { tool: "readFile", path: "c.ts" }),
				tool(5, { tool: "fileDeleted", path: "d.ts" }, { partial: true }),
				{ ts: 6, type: "say", say: "text", text: "not json" },
			]),
		).toEqual(["a.ts", "b.ts"])
	})
})

describe("agent rows", () => {
	const history = [
		item("main"),
		item("side", { parentTaskId: "main", task: "Is 500ms too short?", ts: 30 }),
		item("closed", { parentTaskId: "main", task: "closed", ts: 20, sideClosedAt: 21 }),
		item("btw", { parentTaskId: "main", task: "quick", ts: 25, sideKind: "btw" }),
		item("other", { parentTaskId: "elsewhere", ts: 40 }),
	]

	it("lists this thread's side threads and subagents, newest first, with their kind", () => {
		const rows = buildAgentRows("main", history, { side: "running" }, [
			{ id: "agent", title: "Find callers", status: "done", access: "read", parentTaskId: "main" },
		])
		expect(rows.map((row) => [row.id, row.kind, row.status, row.tucked])).toEqual([
			["side", "side", "running", false],
			["btw", "btw", "done", true],
			["closed", "side", "done", true],
			["agent", "subagent", "done", false],
		])
	})

	it("shows live and recent rows; older finished, closed and side questions wait behind Show more", () => {
		const row = (id: string, status: AgentRow["status"], tucked = false): AgentRow => ({
			id,
			kind: "side",
			title: id,
			status,
			tucked,
			ts: 0,
		})
		const { shown, more } = splitAgentRows([
			row("d1", "done"),
			row("r1", "running"),
			row("d2", "done"),
			row("closed", "done", true),
			row("d3", "done"),
			row("w1", "waiting"),
			row("d4", "done"),
		])
		expect(shown.map((entry) => entry.id)).toEqual(["r1", "w1", "d1", "d2", "d3"])
		expect(more.map((entry) => entry.id)).toEqual(["d4", "closed"])
	})
})

describe("shortTokens", () => {
	it("reads like the context bar", () => {
		expect(shortTokens(950)).toBe("950")
		expect(shortTokens(412_345)).toBe("412k")
		expect(shortTokens(1_000_000)).toBe("1m")
		expect(shortTokens(1_500_000)).toBe("1.5m")
	})
})
