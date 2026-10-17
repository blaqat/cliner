import type { HistoryItem } from "@shared/HistoryItem"
import { describe, expect, it } from "vitest"
import {
	backTarget,
	crumbIdFor,
	describeLocation,
	HOME,
	jumpToLocation,
	MAX_NAV_ENTRIES,
	type NavLocation,
	popLocation,
	pushLocation,
	shouldNameBack,
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

	it("keeps distinct sections and pages apart", () => {
		let entries = pushLocation([HOME], task("t"))
		entries = pushLocation(entries, task("t", "notebook"))
		entries = pushLocation(entries, { kind: "settings", section: "general" })
		entries = pushLocation(entries, { kind: "settings", section: "features" })
		expect(entries).toHaveLength(5)
	})

	it("stays bounded", () => {
		let entries: NavLocation[] = [HOME]
		for (let i = 0; i < MAX_NAV_ENTRIES + 10; i++) entries = pushLocation(entries, thread(String(i)))
		expect(entries).toHaveLength(MAX_NAV_ENTRIES)
		expect(entries[entries.length - 1]).toEqual(thread(String(MAX_NAV_ENTRIES + 9)))
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
			detail: "Features",
		})
	})
})
