import type { HistoryItem } from "@shared/HistoryItem"
import { describe, expect, it } from "vitest"
import {
	addThreadToasts,
	MAX_THREAD_TOASTS,
	noteThreadStopped,
	pruneThreadToasts,
	recentlyStoppedIds,
	type ThreadToast,
	threadToastDurationMs,
	threadToastEvents,
} from "./threadToastRules"

const item = (id: string, extra: Partial<HistoryItem> = {}) =>
	({ id, ts: 1, task: id, tokensIn: 0, tokensOut: 0, totalCost: 0, ...extra }) as HistoryItem

const history = [item("a"), item("b"), item("child", { isSubagent: true, parentTaskId: "a" })]

describe("threadToastEvents", () => {
	it("only sets a baseline on the first snapshot", () => {
		expect(threadToastEvents(undefined, { a: "waiting", b: "done" }, { history })).toEqual([])
	})

	it("toasts a background thread that finishes", () => {
		expect(threadToastEvents({ a: "running" }, { a: "done" }, { history })).toEqual([
			{ threadId: "a", sourceId: "a", kind: "done" },
		])
	})

	it("toasts a background thread that needs input", () => {
		expect(threadToastEvents({ a: "running" }, { a: "waiting" }, { history })).toEqual([
			{ threadId: "a", sourceId: "a", kind: "input" },
		])
	})

	it("skips the thread being viewed", () => {
		expect(threadToastEvents({ a: "running" }, { a: "done" }, { history, viewingThreadId: "a" })).toEqual([])
		expect(threadToastEvents({ a: "running" }, { a: "waiting" }, { history, viewingThreadId: "a" })).toEqual([])
	})

	it("skips failed threads", () => {
		expect(threadToastEvents({ a: "running" }, { a: "error" }, { history })).toEqual([])
	})

	it("skips stopped threads", () => {
		expect(threadToastEvents({ a: "running" }, { a: "done" }, { history, stoppedIds: new Set(["a"]) })).toEqual([])
	})

	it("doesn't call waiting → done (answered then settled) a completion, nor unchanged statuses", () => {
		expect(threadToastEvents({ a: "waiting", b: "done" }, { a: "done", b: "done" }, { history })).toEqual([])
	})

	it("sends subagent input to the parent and never toasts a subagent finishing", () => {
		expect(threadToastEvents({ child: "running" }, { child: "waiting" }, { history })).toEqual([
			{ threadId: "a", sourceId: "child", kind: "input" },
		])
		expect(threadToastEvents({ child: "running" }, { child: "done" }, { history })).toEqual([])
		expect(threadToastEvents({ child: "running" }, { child: "waiting" }, { history, viewingThreadId: "a" })).toEqual([])
	})
})

describe("addThreadToasts / pruneThreadToasts", () => {
	const ids = () => {
		let id = 0
		return () => ++id
	}

	it("puts the newest on top, keeps one per thread and at most three", () => {
		const next = ids()
		let toasts: ThreadToast[] = []
		for (const id of ["a", "b", "c", "d"]) {
			toasts = addThreadToasts(toasts, [{ threadId: id, sourceId: id, kind: "done" }], next)
		}
		expect(toasts.map((toast) => toast.threadId)).toEqual(["d", "c", "b"])
		expect(toasts).toHaveLength(MAX_THREAD_TOASTS)
		toasts = addThreadToasts(toasts, [{ threadId: "b", sourceId: "b", kind: "input" }], next)
		expect(toasts.map((toast) => `${toast.threadId}:${toast.kind}`)).toEqual(["b:input", "d:done", "c:done"])
	})

	it("drops input toasts once handled and any toast for the thread on screen", () => {
		const toasts: ThreadToast[] = [
			{ id: 1, threadId: "a", sourceId: "a", kind: "input" },
			{ id: 2, threadId: "b", sourceId: "b", kind: "done" },
			{ id: 3, threadId: "c", sourceId: "c", kind: "input" },
		]
		const pruned = pruneThreadToasts(toasts, { a: "running", b: "done", c: "waiting" }, undefined)
		expect(pruned.map((toast) => toast.id)).toEqual([2, 3])
		expect(pruneThreadToasts(pruned, { b: "done", c: "waiting" }, "c").map((toast) => toast.id)).toEqual([2])
	})

	it("returns the same list when nothing changes", () => {
		const toasts: ThreadToast[] = [{ id: 1, threadId: "a", sourceId: "a", kind: "done" }]
		expect(pruneThreadToasts(toasts, { a: "done" }, undefined)).toBe(toasts)
	})
})

describe("threadToastDurationMs", () => {
	it("gives needs-input toasts no timer", () => {
		expect(threadToastDurationMs("input", 5)).toBeNull()
	})

	it("uses the setting for completions, falling back to 5 s", () => {
		expect(threadToastDurationMs("done", 8)).toBe(8000)
		expect(threadToastDurationMs("done", undefined)).toBe(5000)
		expect(threadToastDurationMs("done", 0)).toBe(5000)
	})
})

describe("recently stopped threads", () => {
	it("remembers a stop for a short while", () => {
		noteThreadStopped("s1", 1000)
		expect(recentlyStoppedIds(2000).has("s1")).toBe(true)
		expect(recentlyStoppedIds(1000 + 60_000).has("s1")).toBe(false)
	})
})
