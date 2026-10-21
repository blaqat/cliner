import type { HistoryItem } from "@shared/HistoryItem"
import type { TaskGroupSummary } from "@shared/task-groups"
import { describe, expect, it } from "vitest"
import {
	countByKind,
	filterRows,
	fromServerResults,
	mergeResults,
	type SearchRow,
	searchLocal,
	suggestTaskGroup,
} from "./searchUtils"

const group = (id: string, title: string, extra: Partial<TaskGroupSummary> = {}): TaskGroupSummary => ({
	id,
	title,
	tags: [],
	createdAt: 0,
	updatedAt: 0,
	noteCount: 0,
	...extra,
})
const item = (id: string, task: string, extra: Partial<HistoryItem> = {}): HistoryItem => ({
	id,
	ts: 1,
	task,
	tokensIn: 0,
	tokensOut: 0,
	totalCost: 0,
	...extra,
})
const row = (kind: SearchRow["kind"], id: string, score: number, ts = 0, extra: Partial<SearchRow> = {}): SearchRow => ({
	kind,
	id,
	title: id,
	ts,
	score,
	...extra,
})

describe("searchLocal", () => {
	it("matches task titles and tags, and thread titles, first messages and tags", () => {
		const groups = [
			group("g1", "Bulk invoice export", { tags: [{ kind: "ticket", value: "PROJ-482", source: "user" }] }),
			group("g2", "Unrelated"),
		]
		const history = [
			item("t1", "Export perf spike", { tags: [{ kind: "ticket", value: "PROJ-482", source: "auto" }] }),
			item("t2", "Why is CI slow?", { title: "PROJ-482 follow-up" }),
			item("t3", "nothing here"),
			item("sub", "PROJ-482 subagent", { isSubagent: true }),
		]

		const rows = searchLocal("PROJ-482", groups, history)

		expect(rows.map((r) => `${r.kind}:${r.id}`).sort()).toEqual(["task:g1", "thread:t1", "thread:t2"])
		expect(rows.find((r) => r.id === "t2")?.title).toBe("PROJ-482 follow-up")
	})

	it("matches a thread on its task's tags but keeps only its own tags on the row", () => {
		const groups = [group("g1", "Export", { tags: [{ kind: "ticket", value: "PROJ-482", source: "user" }] })]
		const history = [
			item("in", "alpha", { taskGroupId: "g1", tags: [{ kind: "label", value: "own", source: "user" }] }),
			item("out", "beta"),
		]

		const rows = searchLocal("PROJ-482", groups, history).filter((r) => r.kind === "thread")

		expect(rows.map((r) => r.id)).toEqual(["in"])
		expect(rows[0].tags).toEqual([{ kind: "label", value: "own", source: "user" }])
	})

	it("returns nothing for a blank query", () => {
		expect(searchLocal("  ", [group("g", "x")], [item("t", "x")])).toEqual([])
	})
})

describe("mergeResults", () => {
	it("ranks by score, then newest, and keeps the local copy of duplicates", () => {
		const local = [
			row("thread", "t1", 0.1, 5, { tags: [{ kind: "label", value: "x", source: "user" }] }),
			row("task", "g1", 0.3),
		]
		const server = [
			row("thread", "t1", 0.2, 9),
			row("message", "m-old", 0.35, 1),
			row("message", "m-new", 0.35, 2),
			row("note", "plan", 0.25, 0, { taskGroupId: "g1" }),
			row("note", "plan", 0.25, 0, { taskGroupId: "g2" }),
		]

		const merged = mergeResults(local, server)

		expect(merged.map((r) => `${r.kind}:${r.taskGroupId ?? ""}:${r.id}`)).toEqual([
			"thread::t1",
			"note:g1:plan",
			"note:g2:plan",
			"task::g1",
			"message::m-new",
			"message::m-old",
		])
		expect(merged[0].tags).toHaveLength(1)
	})

	it("lists message hits after every other kind, even a looser thread match", () => {
		const merged = mergeResults([row("thread", "loose-thread", 0.39, 1)], [row("message", "exact", 0.35, 9)])
		expect(merged.map((r) => r.id)).toEqual(["loose-thread", "exact"])
	})

	it("keeps the server's rank order for notes instead of re-sorting by recency", () => {
		// The server returns name/description hits before body hits. The newer
		// note here is the body hit, so a recency sort would flip them.
		const server = fromServerResults([
			{
				kind: "note",
				id: "name-hit",
				title: "Needle plans",
				snippet: "deploy steps",
				ts: 100,
				taskGroupId: "g",
				threadId: "",
			},
			{ kind: "note", id: "body-hit", title: "misc", snippet: "…needle…", ts: 999, taskGroupId: "g", threadId: "" },
		])
		const merged = mergeResults([], server)
		expect(merged.map((r) => r.id)).toEqual(["name-hit", "body-hit"])
	})

	it("drops unknown kinds and empty ids from server results", () => {
		const rows = fromServerResults([
			{ kind: "message", id: "m", title: "T", snippet: "s", ts: 3, taskGroupId: "", threadId: "t", author: "" },
			{ kind: "bogus", id: "x", title: "", snippet: "", ts: 0, taskGroupId: "", threadId: "" },
			{ kind: "note", id: "", title: "", snippet: "", ts: 0, taskGroupId: "g", threadId: "" },
		])
		expect(rows).toEqual([expect.objectContaining({ kind: "message", id: "m", threadId: "t", taskGroupId: undefined })])
	})
})

describe("filters", () => {
	it("counts each kind and filters to one", () => {
		const rows = [row("task", "a", 0), row("thread", "b", 0), row("thread", "c", 0), row("message", "d", 0)]
		expect(countByKind(rows)).toEqual({ task: 1, thread: 2, note: 0, message: 1 })
		expect(filterRows(rows, "threads").map((r) => r.id)).toEqual(["b", "c"])
		expect(filterRows(rows, "all")).toHaveLength(4)
	})

	it("narrows messages by who wrote them, leaving other kinds alone", () => {
		const rows = [
			row("thread", "t", 0),
			row("message", "mine", 0, 0, { author: "you" }),
			row("message", "theirs", 0, 0, { author: "agent" }),
		]
		expect(filterRows(rows, "messages", "you").map((r) => r.id)).toEqual(["mine"])
		expect(filterRows(rows, "messages", "agent").map((r) => r.id)).toEqual(["theirs"])
		expect(filterRows(rows, "messages").map((r) => r.id)).toEqual(["mine", "theirs"])
		expect(filterRows(rows, "all", "you").map((r) => r.id)).toEqual(["t", "mine"])
	})

	it("reads the author from server message results", () => {
		const [hit] = fromServerResults([
			{ kind: "message", id: "m", title: "T", snippet: "s", ts: 3, taskGroupId: "", threadId: "t", author: "agent" },
		])
		expect(hit.author).toBe("agent")
	})
})

describe("suggestTaskGroup", () => {
	it("picks the most recently updated task sharing a tag, case-insensitively", () => {
		const groups = [
			group("old", "Old", { updatedAt: 1, tags: [{ kind: "ticket", value: "PROJ-1", source: "user" }] }),
			group("new", "New", { updatedAt: 2, tags: [{ kind: "ticket", value: "proj-1", source: "user" }] }),
			group("label", "Label", { updatedAt: 3, tags: [{ kind: "label", value: "PROJ-1", source: "user" }] }),
		]
		expect(suggestTaskGroup([{ kind: "ticket", value: "PROJ-1", source: "auto" }], groups)?.id).toBe("new")
		expect(suggestTaskGroup([{ kind: "branch", value: "main", source: "user" }], groups)).toBeUndefined()
		expect(suggestTaskGroup(undefined, groups)).toBeUndefined()
	})
})
