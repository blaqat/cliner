import type { HistoryItem } from "@shared/HistoryItem"
import type { TaskGroupSummary } from "@shared/task-groups"
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
	buildInbox,
	countBackgroundRunning,
	describeActivity,
	EXPANDED_TASK_GROUPS_EVENT,
	expandTaskGroupInInbox,
	formatAge,
	type InboxSettledEntry,
	readExpandedTaskGroups,
	writeExpandedTaskGroups,
} from "./inboxUtils"

const NOW = Date.UTC(2026, 8, 30, 12, 0, 0)
const MIN = 60_000

function item(id: string, ts: number, extra: Partial<HistoryItem> = {}): HistoryItem {
	return { id, ts, task: `task ${id}`, tokensIn: 0, tokensOut: 0, totalCost: 0, ...extra }
}

/** A settled entry's id: the thread id, or `group:<id>` for a settled task. */
const settledId = (entry: InboxSettledEntry) => (entry.kind === "thread" ? entry.row.item.id : `group:${entry.row.group.id}`)

describe("buildInbox", () => {
	it("puts unsettled chats on top by recency and settled chats below by last activity (not settle time)", () => {
		const history = [
			item("old", NOW - 50 * MIN),
			item("s1", NOW - 90 * MIN, { isSettled: true, settledAt: NOW - MIN }),
			item("new", NOW - 5 * MIN),
			item("s2", NOW - 20 * MIN, { isSettled: true, settledAt: NOW - 2 * MIN }),
		]

		const { active, settled, hiddenCount } = buildInbox(history, {})

		expect(active.map((row) => row.item.id)).toEqual(["new", "old"])
		expect(settled.map(settledId)).toEqual(["s2", "s1"])
		expect(settled.every((entry) => entry.kind === "thread" && entry.row.settled)).toBe(true)
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

	it("sorts an active row by its newest descendant ts, not the parent's own", () => {
		const history = [
			item("stale", NOW - 60 * MIN),
			item("aside", NOW - 2 * MIN, { parentTaskId: "stale" }),
			item("fresh", NOW - 10 * MIN),
		]

		const { active } = buildInbox(history, {})

		expect(active.map((row) => row.item.id)).toEqual(["stale", "fresh"])
		expect(active[0].activityTs).toBe(NOW - 2 * MIN)
		expect(active[1].activityTs).toBe(NOW - 10 * MIN)
	})

	it("rolls asides of asides into the top-level activity time", () => {
		const history = [
			item("root", NOW - 60 * MIN),
			item("aside", NOW - 30 * MIN, { parentTaskId: "root" }),
			item("nested", NOW - MIN, { parentTaskId: "aside" }),
		]

		const { active } = buildInbox(history, {})

		expect(active.map((row) => row.item.id)).toEqual(["root"])
		expect(active[0].activityTs).toBe(NOW - MIN)
	})

	it("rolls subagent activity into the parent's activity time", () => {
		const history = [item("root", NOW - 60 * MIN), item("agent", NOW - MIN, { isSubagent: true, parentTaskId: "root" })]

		const { active } = buildInbox(history, {})

		expect(active[0].activityTs).toBe(NOW - MIN)
	})

	it("keeps settled rows sorted by their own ts even when a subthread is newer", () => {
		const history = [
			item("s1", NOW - 50 * MIN, { isSettled: true, settledAt: NOW - MIN }),
			item("aside", NOW - 2 * MIN, { parentTaskId: "s1" }),
			item("s2", NOW - 20 * MIN, { isSettled: true, settledAt: NOW - 2 * MIN }),
		]

		const { settled } = buildInbox(history, {})

		expect(settled.map(settledId)).toEqual(["s2", "s1"])
		expect(settled.find((entry) => settledId(entry) === "s1")?.row.activityTs).toBe(NOW - 2 * MIN)
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
		expect(settled[0].row).toMatchObject({ subagentCount: 3, liveSubagentCount: 0 })
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

	it("rolls nested subagent totals and waiting counts up to the root", () => {
		const history = [
			item("root", NOW),
			item("a", NOW + 1, { isSubagent: true, parentTaskId: "root" }),
			item("b", NOW + 2, { isSubagent: true, parentTaskId: "a" }),
		]
		for (const counts of [undefined, { root: { total: 2, live: 0 } }]) {
			const { active } = buildInbox(history, { a: "done", b: "waiting" }, counts)
			expect(active).toHaveLength(1)
			expect(active[0]).toMatchObject({
				item: { id: "root" },
				subagentCount: 2,
				liveSubagentCount: 1,
				attentionSubagentCount: 1,
			})
		}
	})

	it("shows more than three chats and counts what the limits cut", () => {
		const history = Array.from({ length: 20 }, (_, i) => item(`t${i}`, NOW - i * MIN))
		history.push(item("s", NOW, { isSettled: true, settledAt: NOW }))

		const { active, settled, hiddenCount } = buildInbox(history, {}, { activeLimit: 15, settledLimit: 10 })

		expect(active).toHaveLength(15)
		expect(settled).toHaveLength(1)
		expect(hiddenCount).toBe(5)
	})

	it("reports the full settled total beyond the settled limit", () => {
		const history = Array.from({ length: 30 }, (_, i) =>
			item(`s${i}`, NOW - i * MIN, { isSettled: true, settledAt: NOW - i * MIN }),
		)

		const { settled, settledTotal, hiddenCount } = buildInbox(history, {}, undefined, { settledLimit: 10 })

		expect(settled).toHaveLength(10)
		expect(settledTotal).toBe(30)
		expect(hiddenCount).toBe(0)
		expect(buildInbox(history, {}, undefined, { settledLimit: 35 }).settled).toHaveLength(30)
	})

	it("skips history entries without a task or timestamp", () => {
		const { active } = buildInbox([item("ok", NOW), item("empty", NOW, { task: "" }), item("zero", 0)], {})
		expect(active.map((row) => row.item.id)).toEqual(["ok"])
	})
})

describe("inbox helpers", () => {
	it("does not count grouped subagents as additional background chats", () => {
		expect(
			countBackgroundRunning({ parent: "running", child: "running", other: "running" }, "parent", [
				item("child", NOW, { isSubagent: true, parentTaskId: "parent" }),
			]),
		).toBe(1)
	})

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
			activityTs: NOW - MIN,
			status,
			settled,
			subthreadCount: 0,
			liveSubthreadCount: 0,
			subagentCount: 0,
			liveSubagentCount: 0,
			attentionSubagentCount: 0,
		})
		expect(describeActivity(row("running"), NOW)).toBe("Working…")
		expect(describeActivity(row("waiting"), NOW)).toBe("Waiting for you")
		expect(describeActivity(row("error"), NOW)).toBe("Stopped with an error")
		expect(describeActivity(row("done", true), NOW)).toBe("Last active 1m ago")
		expect(describeActivity({ ...row("done", true), activityTs: NOW - 5 * MIN }, NOW)).toBe("Last active 5m ago")
	})

	it("says a subthread is working when the parent is idle but a descendant is live", () => {
		const row = (liveSubthreadCount: number, liveSubagentCount = 0) => ({
			item: item("t", NOW - MIN),
			activityTs: NOW - MIN,
			status: "done" as const,
			settled: false,
			subthreadCount: liveSubthreadCount,
			liveSubthreadCount,
			subagentCount: liveSubagentCount,
			liveSubagentCount,
			attentionSubagentCount: 0,
		})
		expect(describeActivity(row(1), NOW)).toBe("Working… in subthread")
		expect(describeActivity(row(0, 1), NOW)).toBe("Working… in subthread")
		expect(describeActivity({ ...row(1), status: "running" }, NOW)).toBe("Working…")
		// A parent that needs the user still says so while a subthread works.
		expect(describeActivity({ ...row(1), status: "waiting" }, NOW)).toBe("Waiting for you")
		expect(describeActivity({ ...row(1), status: "error" }, NOW)).toBe("Stopped with an error")
		expect(describeActivity(row(0), NOW)).toBe("Done")
	})
})

function group(id: string, updatedAt: number, extra: Partial<TaskGroupSummary> = {}): TaskGroupSummary {
	return { id, title: `group ${id}`, tags: [], createdAt: updatedAt, updatedAt, noteCount: 0, ...extra }
}

describe("buildInbox task groups", () => {
	it("moves member threads under their group and out of the top level", () => {
		const history = [
			item("loose", NOW - 5 * MIN),
			item("m1", NOW - 10 * MIN, { taskGroupId: "g" }),
			item("m2", NOW - 20 * MIN, { taskGroupId: "g", isSettled: true, settledAt: NOW - MIN }),
		]

		const { groups, active, settled, settledTotal } = buildInbox(history, {}, undefined, { taskGroups: [group("g", 0)] })

		expect(active.map((row) => row.item.id)).toEqual(["loose"])
		expect(settled).toHaveLength(0)
		expect(settledTotal).toBe(0)
		expect(groups).toHaveLength(1)
		expect(groups[0].members.map((row) => row.item.id)).toEqual(["m1", "m2"])
	})

	it("lists a task as active only while a member thread is unsettled", () => {
		const history = [
			item("open", NOW - 10 * MIN, { taskGroupId: "live" }),
			item("closed", NOW - 5 * MIN, { taskGroupId: "live", isSettled: true }),
			item("done1", NOW - 30 * MIN, { taskGroupId: "done", isSettled: true }),
			item("done2", NOW - 40 * MIN, { taskGroupId: "done", isSettled: true }),
		]

		const { groups, settled, settledTotal } = buildInbox(history, {}, undefined, {
			taskGroups: [group("live", 0), group("done", 0), group("empty", NOW - 60 * MIN)],
		})

		expect(groups.map((row) => row.group.id)).toEqual(["live"])
		expect(settled.map(settledId)).toEqual(["group:done", "group:empty"])
		expect(settledTotal).toBe(2)
		const done = settled[0]
		expect(done.kind === "group" && done.row.members.map((row) => row.item.id)).toEqual(["done1", "done2"])
	})

	it("keeps a task with a running thread active even if the thread's settled flag lags", () => {
		const history = [item("t", NOW - MIN, { taskGroupId: "g", isSettled: true })]

		const running = buildInbox(history, { t: "running" }, undefined, { taskGroups: [group("g", 0)] })
		expect(running.groups.map((row) => row.group.id)).toEqual(["g"])
		expect(running.settled).toHaveLength(0)
	})

	it("orders settled tasks among settled threads by newest member activity, else the task's update time", () => {
		const history = [
			item("s-new", NOW - 5 * MIN, { isSettled: true }),
			item("member", NOW - 15 * MIN, { taskGroupId: "g", isSettled: true }),
			item("s-mid", NOW - 25 * MIN, { isSettled: true }),
			item("s-old", NOW - 50 * MIN, { isSettled: true }),
		]

		const { settled, settledTotal } = buildInbox(history, {}, undefined, {
			taskGroups: [group("g", NOW - 90 * MIN), group("empty", NOW - 40 * MIN)],
			settledLimit: 4,
		})

		expect(settled.map(settledId)).toEqual(["s-new", "group:g", "s-mid", "group:empty"])
		expect(settledTotal).toBe(5)
	})

	it("keeps threads filed into an unknown (deleted) group at the top level", () => {
		const { groups, active } = buildInbox([item("t", NOW, { taskGroupId: "gone" })], {}, undefined, { taskGroups: [] })

		expect(groups).toHaveLength(0)
		expect(active.map((row) => row.item.id)).toEqual(["t"])
	})

	it("uses the newest member activity (including subthreads) for the group and sorts groups by it", () => {
		const history = [
			item("a1", NOW - 60 * MIN, { taskGroupId: "a" }),
			item("aside", NOW - MIN, { parentTaskId: "a1", taskGroupId: "a" }),
			item("b1", NOW - 10 * MIN, { taskGroupId: "b" }),
		]

		const { groups } = buildInbox(history, {}, undefined, {
			taskGroups: [group("b", NOW - 100 * MIN), group("a", NOW - 100 * MIN)],
		})

		expect(groups.map((row) => row.group.id)).toEqual(["a", "b"])
		expect(groups[0].activityTs).toBe(NOW - MIN)
		// The aside folds into its parent; it isn't a member row of its own.
		expect(groups[0].members.map((row) => row.item.id)).toEqual(["a1"])
	})

	it("lists an aside filed in another task as a member of that task, not under its parent", () => {
		const history = [
			item("parent", NOW - 60 * MIN, { taskGroupId: "a" }),
			item("same", NOW - 30 * MIN, { parentTaskId: "parent", taskGroupId: "a" }),
			item("moved", NOW - MIN, { parentTaskId: "parent", taskGroupId: "b" }),
			item("agent", NOW, { parentTaskId: "moved", isSubagent: true }),
		]

		const { groups, active } = buildInbox(history, { agent: "running" }, undefined, {
			taskGroups: [group("a", 0), group("b", 0)],
		})

		const byId = new Map(groups.map((row) => [row.group.id, row]))
		expect(byId.get("a")?.members.map((row) => row.item.id)).toEqual(["parent"])
		expect(byId.get("a")?.members[0]).toMatchObject({ subthreadCount: 1, activityTs: NOW - 30 * MIN })
		// The moved aside keeps its own subagents and counts toward its own task.
		expect(byId.get("b")?.members.map((row) => row.item.id)).toEqual(["moved"])
		expect(byId.get("b")).toMatchObject({ runningCount: 1, activityTs: NOW })
		expect(active).toHaveLength(0)
	})

	it("lists an aside taken out of its parent's task as an unfiled row", () => {
		const history = [
			item("parent", NOW - 60 * MIN, { taskGroupId: "a" }),
			item("aside", NOW - MIN, { parentTaskId: "parent" }),
		]

		const { groups, active } = buildInbox(history, {}, undefined, { taskGroups: [group("a", 0)] })

		expect(groups[0].members[0]).toMatchObject({ subthreadCount: 0, activityTs: NOW - 60 * MIN })
		expect(active.map((row) => row.item.id)).toEqual(["aside"])
	})

	it("falls back to the group's update time when it has no threads", () => {
		const { groups, settled } = buildInbox([], {}, undefined, { taskGroups: [group("empty", NOW - 3 * MIN)] })

		// An empty task has nothing in progress, so it is listed under Settled.
		expect(groups).toHaveLength(0)
		expect(settled[0]).toMatchObject({
			kind: "group",
			row: { activityTs: NOW - 3 * MIN, members: [], runningCount: 0 },
		})
	})

	it("counts members with work in progress, including busy subthreads", () => {
		const history = [
			item("run", NOW, { taskGroupId: "g" }),
			item("idle", NOW, { taskGroupId: "g" }),
			item("aside", NOW, { parentTaskId: "idle", taskGroupId: "g" }),
			item("done", NOW, { taskGroupId: "g" }),
		]

		const { groups } = buildInbox(history, { run: "running", aside: "running" }, undefined, { taskGroups: [group("g", 0)] })

		expect(groups[0].runningCount).toBe(2)
	})

	it("interleaves active tasks and threads by last activity instead of pinning tasks on top", () => {
		const history = [
			item("newThread", NOW - 1 * MIN),
			item("member", NOW - 30 * MIN, { taskGroupId: "g" }),
			item("oldThread", NOW - 60 * MIN),
		]
		const { activeEntries } = buildInbox(history, {}, undefined, { taskGroups: [group("g", 0)] })
		expect(activeEntries.map(settledId)).toEqual(["newThread", "group:g", "oldThread"])
	})

	it("applies the active limit to unfiled rows only", () => {
		const history = [item("m", NOW, { taskGroupId: "g" }), item("x", NOW - MIN), item("y", NOW - 2 * MIN)]

		const { active, hiddenCount, groups } = buildInbox(history, {}, undefined, {
			activeLimit: 1,
			taskGroups: [group("g", 0)],
		})

		expect(active.map((row) => row.item.id)).toEqual(["x"])
		expect(hiddenCount).toBe(1)
		expect(groups[0].members).toHaveLength(1)
	})
})

describe("expanded task groups", () => {
	beforeEach(() => {
		const store = new Map<string, string>()
		vi.stubGlobal("localStorage", {
			getItem: (key: string) => store.get(key) ?? null,
			setItem: (key: string, value: string) => void store.set(key, value),
		})
	})

	it("starts collapsed and round-trips the expanded set", () => {
		expect(readExpandedTaskGroups().size).toBe(0)
		writeExpandedTaskGroups(new Set(["a", "b"]))
		expect([...readExpandedTaskGroups()]).toEqual(["a", "b"])
	})

	it("ignores malformed storage", () => {
		localStorage.setItem("inbox.expandedTaskGroups", "{not json")
		expect(readExpandedTaskGroups().size).toBe(0)
		localStorage.setItem("inbox.expandedTaskGroups", JSON.stringify(["ok", 3]))
		expect([...readExpandedTaskGroups()]).toEqual(["ok"])
	})

	it("expandTaskGroupInInbox persists the id and notifies the inbox", () => {
		let notified = 0
		const listener = () => notified++
		window.addEventListener(EXPANDED_TASK_GROUPS_EVENT, listener)
		expandTaskGroupInInbox("new")
		window.removeEventListener(EXPANDED_TASK_GROUPS_EVENT, listener)
		expect(readExpandedTaskGroups().has("new")).toBe(true)
		expect(notified).toBe(1)
	})
})
