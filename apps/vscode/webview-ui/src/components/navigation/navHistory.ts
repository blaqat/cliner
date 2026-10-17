import type { HistoryItem } from "@shared/HistoryItem"
import type { TaskGroupSummary } from "@shared/task-groups"
import { threadTitle } from "@/components/chat/chat-view/utils/threadUtils"

/** A place the sidebar can show. Back walks a stack of these. */
export type NavLocation =
	| { kind: "home" }
	| { kind: "search" }
	| { kind: "thread"; id: string }
	| { kind: "walkthrough"; id: string }
	| { kind: "task"; id: string; page: "home" | "notebook" }
	| { kind: "settings"; section?: string }
	| { kind: "history" }
	| { kind: "account" }
	| { kind: "mcp" }
	| { kind: "marketplace" }
	| { kind: "worktrees" }

export const HOME: NavLocation = { kind: "home" }

/** Session history is short-lived; this only keeps a runaway session bounded. */
export const MAX_NAV_ENTRIES = 50

/**
 * The id a breadcrumb uses for this place, when it can appear in one. Matches
 * the `Crumb.id`s built by TaskHeader, TaskGroupPageHeader and SearchView.
 */
export function crumbIdFor(location: NavLocation): string | undefined {
	switch (location.kind) {
		case "home":
			return "home"
		case "search":
			return "search"
		case "walkthrough":
			return `walkthrough:${location.id}`
		case "thread":
			return location.id
		case "task":
			return location.page === "notebook" ? `notebook:${location.id}` : `task:${location.id}`
		default:
			return undefined
	}
}

export function locationKey(location: NavLocation): string {
	switch (location.kind) {
		case "walkthrough":
			return `walkthrough:${location.id}`
		case "thread":
			return `thread:${location.id}`
		case "task":
			return `task:${location.id}:${location.page}`
		case "settings":
			return `settings:${location.section ?? ""}`
		default:
			return location.kind
	}
}

export function sameLocation(a: NavLocation | undefined, b: NavLocation | undefined): boolean {
	return !!a && !!b && locationKey(a) === locationKey(b)
}

/**
 * Records a visit. The last entry is where you are now.
 * - Re-reporting the current place is a no-op.
 * - Arriving where Back would take you (A → B → A, e.g. Settings' Done or a
 *   crumb back to the page you came from) pops instead of growing a loop.
 */
export function pushLocation(entries: readonly NavLocation[], location: NavLocation): NavLocation[] {
	const current = entries[entries.length - 1]
	if (sameLocation(current, location)) return entries as NavLocation[]
	if (sameLocation(entries[entries.length - 2], location)) return entries.slice(0, -1)
	return [...entries, location].slice(-MAX_NAV_ENTRIES)
}

/** The stack after Back, or undefined when there is nowhere to go. */
export function popLocation(entries: readonly NavLocation[]): NavLocation[] | undefined {
	return entries.length > 1 ? entries.slice(0, -1) : undefined
}

/** The stack after jumping to `index` from the history list. */
export function jumpToLocation(entries: readonly NavLocation[], index: number): NavLocation[] | undefined {
	if (index < 0 || index >= entries.length - 1) return undefined
	return entries.slice(0, index + 1)
}

export function backTarget(entries: readonly NavLocation[]): NavLocation | undefined {
	return entries.length > 1 ? entries[entries.length - 2] : undefined
}

/**
 * Back shows its destination's name only when that place is neither Home nor
 * already one of the current breadcrumbs; otherwise the arrow alone is clear.
 */
export function shouldNameBack(target: NavLocation | undefined, crumbIds: readonly string[]): boolean {
	if (!target || target.kind === "home") return false
	const crumbId = crumbIdFor(target)
	return !crumbId || !crumbIds.includes(crumbId)
}

const SETTINGS_SECTION_NAMES: Record<string, string> = {
	"api-config": "API Configuration",
	features: "Features",
	subagents: "Subagents",
	terminal: "Terminal",
	general: "General",
	"remote-config": "Remote Config",
	about: "About",
	debug: "Debug",
}

export interface LocationLabel {
	label: string
	/** Codicon name for the history list. */
	icon: string
	/** Extra context for the history list (e.g. the notebook's task). */
	detail?: string
}

/** Human names for places, looked up from current history and tasks. */
export function describeLocation(
	location: NavLocation,
	history: readonly HistoryItem[],
	taskGroups: readonly TaskGroupSummary[],
): LocationLabel {
	switch (location.kind) {
		case "walkthrough":
			return { label: "Walkthrough", icon: "diff" }
		case "home":
			return { label: "Home", icon: "home" }
		case "search":
			return { label: "Search", icon: "search" }
		case "thread": {
			const item = history.find((entry) => entry.id === location.id)
			const group = item?.taskGroupId ? taskGroups.find((entry) => entry.id === item.taskGroupId) : undefined
			const title = item ? threadTitle(item).replace(/\s+/g, " ").trim() : ""
			return { label: title || "Thread", icon: "comment-discussion", detail: group?.title }
		}
		case "task": {
			const title = taskGroups.find((entry) => entry.id === location.id)?.title ?? "Task"
			return location.page === "notebook"
				? { label: "Notebook", icon: "notebook", detail: title }
				: { label: title, icon: "tasklist" }
		}
		case "settings":
			return { label: "Settings", icon: "settings-gear", detail: SETTINGS_SECTION_NAMES[location.section ?? ""] }
		case "history":
			return { label: "History", icon: "history" }
		case "account":
			return { label: "Account", icon: "account" }
		case "mcp":
			return { label: "MCP Servers", icon: "server" }
		case "marketplace":
			return { label: "Marketplace", icon: "extensions" }
		case "worktrees":
			return { label: "Worktrees", icon: "git-branch" }
	}
}
