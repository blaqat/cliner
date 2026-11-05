import type { HistoryItem } from "@shared/HistoryItem"
import { describe, expect, it } from "vitest"
import { planSettleAll, planStashAll, settleAllMessage, stashAllMessage } from "./settleAll"

const item = (id: string, extra: Partial<HistoryItem> = {}): HistoryItem => ({
	id,
	ts: 1,
	task: id,
	tokensIn: 0,
	tokensOut: 0,
	totalCost: 0,
	taskGroupId: "g",
	...extra,
})

describe("planSettleAll", () => {
	it("settles idle, done and waiting-free threads; skips running; leaves settled ones alone", () => {
		const history = [
			item("done"),
			item("stopped"),
			item("already", { isSettled: true }),
			item("busy"),
			item("asking"),
			item("aside", { parentTaskId: "done" }),
			item("agent", { isSubagent: true, parentTaskId: "busy" }),
			item("other", { taskGroupId: "h" }),
			item("loose", { taskGroupId: undefined }),
		]
		const plan = planSettleAll("g", history, { busy: "running", asking: "waiting", stopped: "done" })
		expect(plan).toEqual({
			mode: "settle",
			targets: ["done", "stopped", "aside"],
			running: 2,
			alreadySettled: 1,
			total: 6,
		})
	})

	it("flips to Unsettle all once every thread is settled", () => {
		const history = [item("a", { isSettled: true }), item("b", { isSettled: true }), item("agent", { isSubagent: true })]
		expect(planSettleAll("g", history, undefined)).toMatchObject({ mode: "unsettle", targets: ["a", "b"], total: 2 })
	})

	it("has nothing to do for a task without threads", () => {
		expect(planSettleAll("g", [item("x", { taskGroupId: "h" })], undefined)).toMatchObject({
			mode: "settle",
			targets: [],
			total: 0,
		})
	})

	it("only running threads left: nothing to settle but they are reported", () => {
		const plan = planSettleAll("g", [item("a", { isSettled: true }), item("b")], { b: "running" })
		expect(plan).toMatchObject({ mode: "settle", targets: [], running: 1, alreadySettled: 1 })
	})
})

describe("settleAllMessage", () => {
	it("reads 'Settled 4 · 1 still running'", () => {
		expect(settleAllMessage("settle", 4, 1)).toBe("Settled 4 · 1 still running")
		expect(settleAllMessage("settle", 4, 0)).toBe("Settled 4")
		expect(settleAllMessage("unsettle", 3, 0)).toBe("Unsettled 3")
	})
})

describe("planStashAll", () => {
	it("stashes every unstashed thread in the task (asides too, not subagents or other tasks)", () => {
		const history = [
			item("a"),
			item("b", { isStashed: true }),
			item("c", { isSettled: true }),
			item("aside", { parentTaskId: "a" }),
			item("agent", { isSubagent: true, parentTaskId: "a" }),
			item("other", { taskGroupId: "h" }),
		]
		expect(planStashAll("g", history)).toEqual({ mode: "stash", targets: ["a", "c", "aside"], total: 4 })
	})

	it("unstashes them all once every thread is stashed", () => {
		const history = [item("a", { isStashed: true }), item("b", { isStashed: true })]
		expect(planStashAll("g", history)).toEqual({ mode: "unstash", targets: ["a", "b"], total: 2 })
	})

	it("has nothing to do for a task with no threads", () => {
		expect(planStashAll("g", [])).toEqual({ mode: "stash", targets: [], total: 0 })
		expect(stashAllMessage("stash", 3)).toBe("Stashed 3")
		expect(stashAllMessage("unstash", 2)).toBe("Unstashed 2")
	})
})
