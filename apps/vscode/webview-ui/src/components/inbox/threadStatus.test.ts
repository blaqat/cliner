import type { HistoryItem } from "@shared/HistoryItem"
import { describe, expect, it } from "vitest"
import {
	buildThreadStatuses,
	deriveThreadStatus,
	threadStatusFor,
	threadStatusLabel,
	threadStatusMap,
	waitingOnLabel,
} from "./threadStatus"

const item = (id: string, extra: Partial<HistoryItem> = {}): HistoryItem => ({
	id,
	ts: 1,
	task: `task ${id}`,
	tokensIn: 0,
	tokensOut: 0,
	totalCost: 0,
	...extra,
})

const history = [
	item("p"),
	item("a", { parentTaskId: "p", isSubagent: true }),
	item("b", { parentTaskId: "p", isSubagent: true }),
	item("nested", { parentTaskId: "a", isSubagent: true }),
	item("aside", { parentTaskId: "p" }),
]

describe("deriveThreadStatus", () => {
	const none = { liveSubagents: 0, liveSubthreads: 0, attentionSubagents: 0 }

	it("turns an idle thread with live children into waiting on subagents", () => {
		expect(deriveThreadStatus("done", { ...none, liveSubagents: 1 })).toBe("subagents")
		expect(deriveThreadStatus("done", { ...none, liveSubthreads: 1 })).toBe("subagents")
		expect(deriveThreadStatus("done", none)).toBe("done")
	})

	it("lets a subagent that needs the user win, and leaves non-idle threads alone", () => {
		expect(deriveThreadStatus("done", { liveSubagents: 2, liveSubthreads: 0, attentionSubagents: 1 })).toBe("waiting")
		expect(deriveThreadStatus("running", { ...none, liveSubagents: 1 })).toBe("running")
		expect(deriveThreadStatus("error", { ...none, liveSubagents: 1 })).toBe("error")
		expect(deriveThreadStatus("waiting", { ...none, liveSubagents: 1 })).toBe("waiting")
	})
})

describe("buildThreadStatuses", () => {
	it("is waiting while any subagent runs, done once all are done", () => {
		const waiting = buildThreadStatuses(history, { p: "done", a: "running", b: "running" })
		expect(waiting.p).toMatchObject({ status: "subagents", liveSubagents: 2, liveSubthreads: 0 })
		expect(threadStatusLabel(waiting.p)).toBe("Waiting on 2 subagents")

		const finished = buildThreadStatuses(history, { p: "done", a: "done", b: "done" })
		expect(threadStatusFor(finished, "p")).toBe("done")
		expect(threadStatusLabel(finished.p)).toBeUndefined()
	})

	it("counts nested subagents and running subthreads", () => {
		const statuses = buildThreadStatuses(history, { p: "done", nested: "running", aside: "running" })
		expect(statuses.p).toMatchObject({ status: "subagents", liveSubagents: 1, liveSubthreads: 1 })
		expect(threadStatusLabel(statuses.p)).toBe("Waiting on 1 subagent and 1 subthread")
		// The subagent whose own turn ended waits on its nested child too.
		expect(threadStatusFor(statuses, "a")).toBe("subagents")
	})

	it("prefers waiting for you when a subagent needs input", () => {
		const statuses = buildThreadStatuses(history, { p: "done", a: "waiting", b: "running" })
		expect(threadStatusFor(statuses, "p")).toBe("waiting")
	})

	it("covers ids that are only in the status map, and flattens to a plain map", () => {
		const statuses = buildThreadStatuses([], { lone: "running" })
		expect(threadStatusMap(statuses)).toEqual({ lone: "running" })
		expect(threadStatusFor(statuses, "missing")).toBe("done")
	})
})

describe("waitingOnLabel", () => {
	it("names what the thread waits on", () => {
		expect(waitingOnLabel(1, 0)).toBe("Waiting on 1 subagent")
		expect(waitingOnLabel(0, 2)).toBe("Waiting on 2 subthreads")
		expect(waitingOnLabel(0, 0)).toBe("Waiting on subagents")
	})
})
