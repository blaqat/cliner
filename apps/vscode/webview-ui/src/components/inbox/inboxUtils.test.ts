import type { HistoryItem } from "@shared/HistoryItem"
import { describe, expect, it } from "vitest"
import { buildInbox, countBackgroundRunning, describeActivity, formatAge } from "./inboxUtils"

const NOW = Date.UTC(2026, 8, 30, 12, 0, 0)
const MIN = 60_000

function item(id: string, ts: number, extra: Partial<HistoryItem> = {}): HistoryItem {
	return { id, ts, task: `task ${id}`, tokensIn: 0, tokensOut: 0, totalCost: 0, ...extra }
}

describe("buildInbox", () => {
	it("puts unsettled chats on top by recency and settled chats below by settle time", () => {
		const history = [
			item("old", NOW - 50 * MIN),
			item("s1", NOW - 90 * MIN, { isSettled: true, settledAt: NOW - 80 * MIN }),
			item("new", NOW - 5 * MIN),
			item("s2", NOW - 200 * MIN, { isSettled: true, settledAt: NOW - 10 * MIN }),
		]

		const { active, settled, hiddenCount } = buildInbox(history, {})

		expect(active.map((row) => row.item.id)).toEqual(["new", "old"])
		expect(settled.map((row) => row.item.id)).toEqual(["s2", "s1"])
		expect(settled.every((row) => row.settled)).toBe(true)
		expect(hiddenCount).toBe(0)
	})

	it("folds asides into their parent's subthread counts and flags live ones", () => {
		const history = [
			item("root", NOW - 30 * MIN),
			item("a1", NOW - 20 * MIN, { parentTaskId: "root" }),
			item("a2", NOW - 10 * MIN, { parentTaskId: "root" }),
			item("orphan", NOW - 5 * MIN, { parentTaskId: "deleted" }),
		]

		const { active } = buildInbox(history, { a2: "running", a1: "done" })

		expect(active.map((row) => row.item.id)).toEqual(["orphan", "root"])
		const root = active.find((row) => row.item.id === "root")
		expect(root?.subthreadCount).toBe(2)
		expect(root?.liveSubthreadCount).toBe(1)
	})

	it("reads subagent counts from live state, falling back to the persisted total", () => {
		const history = [
			item("live", NOW - 5 * MIN),
			item("settled", NOW - 30 * MIN, { isSettled: true, settledAt: NOW - MIN, subagentCount: 3 }),
			item("none", NOW - 10 * MIN),
		]

		const { active, settled } = buildInbox(history, {}, { live: { total: 4, live: 2 } })

		const liveRow = active.find((row) => row.item.id === "live")
		expect(liveRow).toMatchObject({ subagentCount: 4, liveSubagentCount: 2 })
		expect(settled[0]).toMatchObject({ subagentCount: 3, liveSubagentCount: 0 })
		expect(active.find((row) => row.item.id === "none")).toMatchObject({ subagentCount: 0, liveSubagentCount: 0 })
	})

	it("reads status from sessionStatuses and never shows a live chat as settled", () => {
		const history = [item("t1", NOW - MIN, { isSettled: true, settledAt: NOW }), item("t2", NOW - 2 * MIN)]

		const { active, settled } = buildInbox(history, { t1: "running", t2: "waiting" })

		expect(settled).toHaveLength(0)
		expect(active.map((row) => [row.item.id, row.status])).toEqual([
			["t1", "running"],
			["t2", "waiting"],
		])
	})

	it("shows more than three chats and counts what the limits cut", () => {
		const history = Array.from({ length: 20 }, (_, i) => item(`t${i}`, NOW - i * MIN))
		history.push(item("s", NOW, { isSettled: true, settledAt: NOW }))

		const { active, settled, hiddenCount } = buildInbox(history, {}, { activeLimit: 15, settledLimit: 10 })

		expect(active).toHaveLength(15)
		expect(settled).toHaveLength(1)
		expect(hiddenCount).toBe(5)
	})

	it("skips history entries without a task or timestamp", () => {
		const { active } = buildInbox([item("ok", NOW), item("empty", NOW, { task: "" }), item("zero", 0)], {})
		expect(active.map((row) => row.item.id)).toEqual(["ok"])
	})
})

describe("inbox helpers", () => {
	it("counts other running tasks for the header indicator", () => {
		expect(countBackgroundRunning({ a: "running", b: "running", c: "waiting", d: "done" }, "a")).toBe(1)
		expect(countBackgroundRunning(undefined, undefined)).toBe(0)
	})

	it("formats ages compactly", () => {
		expect(formatAge(NOW - 30_000, NOW)).toBe("now")
		expect(formatAge(NOW - 5 * MIN, NOW)).toBe("5m")
		expect(formatAge(NOW - 3 * 60 * MIN, NOW)).toBe("3h")
		expect(formatAge(NOW - 49 * 60 * MIN, NOW)).toBe("2d")
	})

	it("describes the latest activity per status", () => {
		const row = (status: "running" | "waiting" | "done" | "error", settled = false) => ({
			item: item("t", NOW - MIN, { settledAt: NOW - 3 * MIN }),
			status,
			settled,
			subthreadCount: 0,
			liveSubthreadCount: 0,
			subagentCount: 0,
			liveSubagentCount: 0,
		})
		expect(describeActivity(row("running"), NOW)).toBe("Working…")
		expect(describeActivity(row("waiting"), NOW)).toBe("Waiting for you")
		expect(describeActivity(row("error"), NOW)).toBe("Stopped with an error")
		expect(describeActivity(row("done", true), NOW)).toBe("Settled 3m ago")
	})
})
