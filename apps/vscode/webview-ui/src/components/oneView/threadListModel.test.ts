import type { HistoryItem } from "@shared/HistoryItem"
import type { TaskGroupSummary } from "@shared/task-groups"
import { describe, expect, it } from "vitest"
import { buildInbox, type InboxRow } from "@/components/inbox/inboxUtils"
import type { SearchRow } from "@/components/search/searchUtils"
import {
	clampListWidth,
	dockAt,
	LIST_MAX_WIDTH,
	LIST_MIN_WIDTH,
	MAIN_MIN_WIDTH,
	resolvePlacement,
	WIDE_MIN_WIDTH,
} from "./layoutPrefs"
import { filterList, focusSnippet, mapSearchRows, rowLine, stripThreads, topThreadId, visibleStripChips } from "./threadListModel"

const NOW = Date.UTC(2026, 9, 29, 12)
const item = (id: string, extra: Partial<HistoryItem> = {}): HistoryItem => ({
	id,
	ts: NOW - 60_000,
	task: `task ${id}`,
	tokensIn: 0,
	tokensOut: 0,
	totalCost: 0,
	...extra,
})
const row = (extra: Partial<HistoryItem> = {}, status: InboxRow["status"] = "done", settled = false): InboxRow => ({
	item: item("a", extra),
	activityTs: NOW,
	agentActivityTs: NOW,
	status,
	settled,
	subthreadCount: 0,
	liveSubthreadCount: 0,
	subagentCount: 0,
	liveSubagentCount: 0,
	attentionSubagentCount: 0,
})
const group = (id: string, title = `Task ${id}`): TaskGroupSummary => ({
	id,
	title,
	tags: [],
	createdAt: NOW,
	updatedAt: NOW - 10 * 60_000,
})

describe("rowLine", () => {
	it("prefixes the last line by who said it", () => {
		expect(rowLine(row({ lastLine: { author: "user", text: "ship it" } }), NOW)).toEqual({
			kind: "you",
			prefix: "You:",
			text: "ship it",
		})
		expect(rowLine(row({ lastLine: { author: "agent", text: "All tests pass." } }), NOW)).toEqual({
			kind: "agent",
			prefix: "Agent:",
			text: "All tests pass.",
		})
		expect(rowLine(row({ lastLine: { author: "ask", text: "approve edit to a.ts" } }), NOW)).toMatchObject({
			kind: "ask",
			prefix: "Needs you:",
		})
	})

	it("leads with what a waiting thread needs, even when the agent asked a question", () => {
		expect(rowLine(row({ lastLine: { author: "agent", text: "Which branch?" } }, "waiting"), NOW)).toEqual({
			kind: "ask",
			prefix: "Needs you:",
			text: "Which branch?",
		})
		expect(rowLine(row({ lastLine: { author: "user", text: "go" } }, "waiting"), NOW)).toEqual({
			kind: "ask",
			text: "Waiting for you",
		})
	})

	it("shows Working… for a running thread until the agent has a line", () => {
		expect(rowLine(row({ lastLine: { author: "user", text: "go" } }, "running"), NOW)).toEqual({
			kind: "working",
			text: "Working…",
		})
		expect(rowLine(row({ lastLine: { author: "agent", text: "reading McpHub.ts" } }, "running"), NOW)).toMatchObject({
			kind: "agent",
			text: "reading McpHub.ts",
		})
	})

	it("falls back to the inbox activity text for threads without a last line", () => {
		expect(rowLine(row({ modelId: "opus" }), NOW)).toEqual({ kind: "plain", text: "Done · opus" })
		expect(rowLine(row({}, "error"), NOW)).toEqual({ kind: "plain", text: "Stopped with an error" })
	})
})

describe("search mapping", () => {
	const history = [item("top"), item("aside", { parentTaskId: "top" }), item("other")]
	const rows: SearchRow[] = [
		{ kind: "thread", id: "other", title: "other", ts: 1, score: 0.1, threadId: "other" },
		{
			kind: "message",
			id: "m1",
			title: "aside",
			ts: 1,
			score: 0.35,
			threadId: "aside",
			snippet: "fix crlf handling",
			author: "you",
		},
		{ kind: "task", id: "g1", title: "Release", ts: 1, score: 0.1 },
		{ kind: "note", id: "n1", title: "CRLF notes", ts: 1, score: 0.25, taskGroupId: "g1" },
	]

	it("rolls asides up to their thread and keeps the message hit for the second line", () => {
		expect(topThreadId("aside", new Map(history.map((entry) => [entry.id, entry])))).toBe("top")
		const matches = mapSearchRows(rows, history)
		expect(matches.threads.get("top")).toEqual({ snippet: "fix crlf handling", author: "you" })
		expect(matches.threads.get("other")).toEqual({})
		expect([...matches.tasks]).toEqual(["g1"])
		expect(matches.notes.map((note) => note.id)).toEqual(["n1"])
	})

	it("narrows the list to matches, keeps only matching threads under a task, and honors the chips", () => {
		const groups = [group("g1"), group("g2")]
		const inbox = buildInbox(
			[
				item("a", { taskGroupId: "g1" }),
				item("b", { taskGroupId: "g1" }),
				item("c", { taskGroupId: "g2" }),
				item("loose"),
				item("old", { isSettled: true }),
				item("hidden", { isStashed: true }),
			],
			{},
			undefined,
			{ taskGroups: groups },
		)
		const matches = {
			threads: new Map([
				["b", {}],
				["loose", {}],
				["old", {}],
				["hidden", {}],
			]),
			tasks: new Set(["g2"]),
			notes: [rows[3]],
		}
		const all = filterList(inbox, matches)
		const active = all.sections.find((section) => section.id === "active")
		const g1 = active?.entries.find((entry) => entry.kind === "group" && entry.row.group.id === "g1")
		expect(g1?.kind === "group" && g1.row.members.map((member) => member.item.id)).toEqual(["b"])
		const g2 = active?.entries.find((entry) => entry.kind === "group" && entry.row.group.id === "g2")
		expect(g2?.kind === "group" && g2.row.members).toEqual([])
		expect(all.sections.map((section) => section.id)).toEqual(["active", "stashed", "settled"])
		expect(all.count).toBe(7)

		const threadsOnly = filterList(inbox, matches, { kinds: new Set(["threads"]), states: new Set(["settled"]) })
		expect(threadsOnly.sections.map((section) => section.id)).toEqual(["settled"])
		expect(threadsOnly.notes).toEqual([])

		const tasksOnly = filterList(inbox, matches, { kinds: new Set(["tasks"]), states: new Set() })
		expect(tasksOnly.sections.flatMap((section) => section.entries.map((entry) => entry.kind))).toEqual(["group"])
	})

	it("starts a long snippet just before the hit", () => {
		expect(focusSnippet("short crlf", "crlf")).toBe("short crlf")
		const long = `${"x".repeat(60)} crlf tail`
		expect(focusSnippet(long, "CRLF")).toBe(`…${"x".repeat(17)} crlf tail`)
	})
})

describe("strip chips", () => {
	it("lists active threads and always includes the open one", () => {
		const history = [item("a"), item("b", { ts: NOW - 120_000 }), item("s", { isStashed: true })]
		const inbox = buildInbox(history, {}, undefined, {})
		expect(stripThreads(inbox, undefined, history).map((entry) => entry.item.id)).toEqual(["a", "b"])
		expect(stripThreads(inbox, "s", history).map((entry) => entry.item.id)).toEqual(["s", "a", "b"])
	})

	it("swaps the open thread into the last visible slot", () => {
		const rows = ["a", "b", "c", "d"].map((id) => ({ ...row(), item: item(id) }))
		expect(visibleStripChips(rows, 2, "d").map((entry) => entry.item.id)).toEqual(["a", "d"])
		expect(visibleStripChips(rows, 0, undefined)).toHaveLength(1)
	})
})

describe("layout", () => {
	it("is the strip below the wide threshold, the user's dock above it", () => {
		expect(resolvePlacement(WIDE_MIN_WIDTH - 1, "right")).toBe("top")
		expect(resolvePlacement(WIDE_MIN_WIDTH, "right")).toBe("right")
		expect(resolvePlacement(900, "top")).toBe("top")
	})

	it("keeps the side list between its bounds and leaves the chat room", () => {
		expect(clampListWidth(10, 1200)).toBe(LIST_MIN_WIDTH)
		expect(clampListWidth(900, 1200)).toBe(LIST_MAX_WIDTH)
		expect(clampListWidth(400, 600)).toBe(600 - MAIN_MIN_WIDTH)
	})

	it("docks on top in the top quarter, else by side", () => {
		const rect = { left: 0, top: 0, width: 800, height: 400 }
		expect(dockAt(400, 50, rect)).toBe("top")
		expect(dockAt(100, 300, rect)).toBe("left")
		expect(dockAt(700, 300, rect)).toBe("right")
	})
})
