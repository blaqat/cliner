import type { HistoryItem } from "@shared/HistoryItem"
import { describe, expect, it } from "vitest"
import {
	backTarget,
	canonicalSettingsLocation,
	crumbIdFor,
	describeLocation,
	HOME,
	jumpToLocation,
	MAX_NAV_ENTRIES,
	type NavLocation,
	popLocation,
	pushLocation,
	shouldNameBack,
	withoutGoneThreads,
} from "./navHistory"

const thread = (id: string): NavLocation => ({ kind: "thread", id })
const task = (id: string, page: "home" | "notebook" = "home"): NavLocation => ({ kind: "task", id, page })
const search: NavLocation = { kind: "search" }

describe("pushLocation", () => {
	it("appends new places", () => {
		expect(pushLocation([HOME], thread("a"))).toEqual([HOME, thread("a")])
	})

	it("ignores re-reporting the current place", () => {
		const entries = [HOME, thread("a")]
		expect(pushLocation(entries, thread("a"))).toBe(entries)
	})

	it("pops instead of looping when you return to where you came from", () => {
		expect(pushLocation([HOME, thread("a"), { kind: "settings", section: "features" }], thread("a"))).toEqual([
			HOME,
			thread("a"),
		])
	})

	it("treats Settings' pages as one place to leave, so Done leaves no way back into it", () => {
		const thread: NavLocation = { kind: "thread", id: "t1" }
		const models: NavLocation = { kind: "settings", section: "models" }
		const agent: NavLocation = { kind: "settings", section: "agent" }
		expect(pushLocation([HOME, thread, agent], thread)).toEqual([HOME, thread])
		// Settings was the first thing open: nothing to go back to, Settings included.
		expect(pushLocation([agent], thread)).toEqual([thread])
		// Leaving for somewhere else still comes back through it.
		expect(pushLocation([thread, models], { kind: "history" })).toEqual([thread, models, { kind: "history" }])
	})

	it("moving between Settings' pages replaces the entry, so Back still leaves Settings", () => {
		const models: NavLocation = { kind: "settings", section: "models" }
		const agent: NavLocation = { kind: "settings", section: "agent" }
		const tools: NavLocation = { kind: "settings", section: "tools" }
		let entries = pushLocation([HOME, thread("a"), models], agent)
		expect(entries).toEqual([HOME, thread("a"), agent])
		entries = pushLocation(entries, tools)
		expect(entries).toEqual([HOME, thread("a"), tools])
		expect(backTarget(entries)).toEqual(thread("a"))
		// Opened first: still nowhere to go back to.
		expect(backTarget(pushLocation([models], agent))).toBeUndefined()
		// A return to Settings after leaving it is a new visit, and it too keeps one entry.
		const again = pushLocation([thread("a"), models, search], agent)
		expect(pushLocation(again, models)).toEqual([thread("a"), models, search, models])
	})

	it("keeps distinct sections and pages apart", () => {
		let entries = pushLocation([HOME], task("t"))
		entries = pushLocation(entries, task("t", "notebook"))
		expect(entries).toHaveLength(3)
	})

	it("resets the stack when you arrive at Home, so Back has nothing before it", () => {
		const settings: NavLocation = { kind: "settings", section: "general" }
		const atHome = pushLocation([HOME, thread("a"), settings], HOME)
		expect(atHome).toEqual([HOME])
		expect(backTarget(atHome)).toBeUndefined()
		expect(popLocation(atHome)).toBeUndefined()
		// Even when Home is not the immediately previous entry.
		expect(pushLocation([thread("a"), task("t"), search], HOME)).toEqual([HOME])
	})

	it("stays bounded", () => {
		let entries: NavLocation[] = [HOME]
		for (let i = 0; i < MAX_NAV_ENTRIES + 10; i++) entries = pushLocation(entries, thread(String(i)))
		expect(entries).toHaveLength(MAX_NAV_ENTRIES)
		expect(entries[entries.length - 1]).toEqual(thread(String(MAX_NAV_ENTRIES + 9)))
	})
})

describe("withoutGoneThreads", () => {
	const history = [{ id: "a" }, { id: "b" }] as HistoryItem[]

	it("drops threads that have left history, never the current place", () => {
		expect(withoutGoneThreads([HOME, thread("failed"), thread("a")], history)).toEqual([HOME, thread("a")])
		expect(withoutGoneThreads([HOME, thread("a"), thread("failed")], history)).toEqual([HOME, thread("a"), thread("failed")])
	})

	it("keeps the same list when nothing is gone, and leaves other places alone", () => {
		const entries = [HOME, search, task("t"), thread("a"), { kind: "settings" } as NavLocation, thread("b")]
		expect(withoutGoneThreads(entries, history)).toBe(entries)
	})
})

describe("popLocation / jumpToLocation / backTarget", () => {
	const entries = [HOME, search, thread("a"), task("t")]

	it("goes back one step", () => {
		expect(backTarget(entries)).toEqual(thread("a"))
		expect(popLocation(entries)).toEqual([HOME, search, thread("a")])
	})

	it("has nowhere to go from the first entry", () => {
		expect(popLocation([HOME])).toBeUndefined()
		expect(backTarget([HOME])).toBeUndefined()
	})

	it("a Back or jump that lands on Home leaves just Home", () => {
		// A stack that somehow kept earlier entries before a Home entry is normalised.
		const stale = [thread("a"), HOME, search]
		expect(popLocation(stale)).toEqual([HOME])
		expect(jumpToLocation([thread("a"), HOME, search], 1)).toEqual([HOME])
	})

	it("jumps to an earlier entry, not the current one", () => {
		expect(jumpToLocation(entries, 1)).toEqual([HOME, search])
		expect(jumpToLocation(entries, 3)).toBeUndefined()
		expect(jumpToLocation(entries, -1)).toBeUndefined()
	})
})

describe("shouldNameBack", () => {
	it("never names Home", () => {
		expect(shouldNameBack(HOME, [])).toBe(false)
	})

	it("doesn't name a target that is already a breadcrumb", () => {
		// Home → task → thread: Back is the task, which the thread's crumbs show.
		expect(shouldNameBack(task("t"), ["home", "task:t", "a"])).toBe(false)
		expect(shouldNameBack(thread("parent"), ["home", "parent", "aside"])).toBe(false)
		expect(shouldNameBack(task("t", "notebook"), ["home", "task:t", "notebook:t"])).toBe(false)
	})

	it("names a target outside the breadcrumbs", () => {
		// ⌕ → thread: Back is Search, which the thread's crumbs don't show.
		expect(shouldNameBack(search, ["home", "task:t", "a"])).toBe(true)
		expect(shouldNameBack(thread("other"), ["home", "task:t", "a"])).toBe(true)
		expect(shouldNameBack({ kind: "settings", section: "general" }, ["home", "a"])).toBe(true)
	})

	it("names nothing when there is no target", () => {
		expect(shouldNameBack(undefined, [])).toBe(false)
	})

	it("maps places to the crumb ids the headers use", () => {
		expect(crumbIdFor(task("t"))).toBe("task:t")
		expect(crumbIdFor(task("t", "notebook"))).toBe("notebook:t")
		expect(crumbIdFor({ kind: "history" })).toBeUndefined()
	})
})

describe("describeLocation", () => {
	const history = [{ id: "a", ts: 1, task: "Fix  the\nlogin bug", taskGroupId: "t" } as HistoryItem]
	const groups = [{ id: "t", title: "Auth", tags: [], createdAt: 0, updatedAt: 0, noteCount: 0 }]

	it("names threads, tasks and notebooks from current state", () => {
		expect(describeLocation(thread("a"), history, groups)).toMatchObject({ label: "Fix the login bug", detail: "Auth" })
		expect(describeLocation(task("t"), history, groups).label).toBe("Auth")
		expect(describeLocation(task("t", "notebook"), history, groups)).toMatchObject({ label: "Notebook", detail: "Auth" })
		expect(describeLocation(thread("gone"), history, groups).label).toBe("Thread")
		expect(describeLocation({ kind: "settings", section: "features" }, [], [])).toMatchObject({
			label: "Settings",
			detail: "Agent",
		})
	})
})

describe("settings places", () => {
	it.each([
		["models", "Models"],
		["agent", "Agent"],
		["tools", "Tools"],
		["layout", "Layout"],
		["data", "Data & privacy"],
		["api-config", "Models"],
		["general", "Agent"],
	])("names %s", (section, detail) => {
		expect(describeLocation({ kind: "settings", section }, [], []).detail).toBe(detail)
	})

	it.each([
		["api-config", "models"],
		["profiles", "models"],
		["features", "agent"],
		["general", "agent"],
		["terminal", "tools"],
		["remote-config", "about"],
		["agent", "agent"],
	])("reads the old %s entry as %s", (section, page) => {
		expect(canonicalSettingsLocation({ kind: "settings", section })).toEqual({ kind: "settings", section: page })
	})

	it("leaves other places and an unnamed section alone", () => {
		expect(canonicalSettingsLocation(HOME)).toBe(HOME)
		const bare: NavLocation = { kind: "settings" }
		expect(canonicalSettingsLocation(bare)).toBe(bare)
	})
})
