import type { HistoryItem } from "@shared/HistoryItem"
import {
	describeActivity,
	type InboxEntry,
	type InboxGroups,
	type InboxRow,
	type InboxTaskGroupRow,
	isRowWorking,
} from "@/components/inbox/inboxUtils"
import type { MessageAuthor, SearchRow } from "@/components/search/searchUtils"

/** How a row's second line reads: who said it decides the prefix and its color. */
export type RowLineKind = "you" | "agent" | "ask" | "working" | "plain"

export interface RowLine {
	kind: RowLineKind
	/** "You:", "Agent:" or "Needs you:"; absent for status text. */
	prefix?: string
	text: string
}

const PREFIX: Record<"you" | "agent" | "ask", string> = { you: "You:", agent: "Agent:", ask: "Needs you:" }

/**
 * A list row's second line: the thread's last line with who said it. A thread waiting for you
 * leads with what it needs; a running one shows the agent's latest line, or "Working…" before
 * there is one. Threads from before last lines were recorded fall back to the inbox's activity text.
 */
export function rowLine(row: InboxRow, now: number): RowLine {
	const line = row.item.lastLine
	if (!row.settled && row.status === "waiting") {
		return line && line.author !== "user"
			? { kind: "ask", prefix: PREFIX.ask, text: line.text }
			: { kind: "ask", text: "Waiting for you" }
	}
	if (!row.settled && row.status === "running") {
		return line?.author === "agent"
			? { kind: "agent", prefix: PREFIX.agent, text: line.text }
			: { kind: "working", text: "Working…" }
	}
	if (line) {
		const kind = line.author === "user" ? "you" : line.author
		return { kind, prefix: PREFIX[kind], text: line.text }
	}
	return { kind: "plain", text: describeActivity(row, now) }
}

/** A thread that matched the search: a message hit carries its snippet and author. */
export interface ThreadHit {
	snippet?: string
	author?: MessageAuthor
}

export interface ListSearchMatches {
	/** Top-level thread id (asides and subagents roll up to their parent) → the hit to show. */
	threads: Map<string, ThreadHit>
	/** Tasks matched by their own title or tags. */
	tasks: Set<string>
	notes: SearchRow[]
}

/** The list row a thread shows under: asides and subagents roll up to their top-level parent. */
export function topThreadId(id: string, byId: ReadonlyMap<string, HistoryItem>): string {
	const seen = new Set<string>()
	let current = id
	for (let parent = byId.get(current)?.parentTaskId; parent && byId.has(parent); parent = byId.get(current)?.parentTaskId) {
		if (seen.has(parent)) break
		seen.add(parent)
		current = parent
	}
	return current
}

/**
 * Maps the search view's ranked results (local title/tag matches plus the host's message and
 * note hits) onto the list: which threads and tasks stay, and the notes to list below them.
 * A message hit wins over a title hit for the row's second line (it shows where the match is).
 */
export function mapSearchRows(rows: readonly SearchRow[], history: readonly HistoryItem[]): ListSearchMatches {
	const byId = new Map(history.map((item) => [item.id, item]))
	const threads = new Map<string, ThreadHit>()
	const tasks = new Set<string>()
	const notes: SearchRow[] = []
	for (const row of rows) {
		if (row.kind === "task") tasks.add(row.id)
		else if (row.kind === "note") notes.push(row)
		else {
			const id = topThreadId(row.threadId ?? row.id, byId)
			const existing = threads.get(id)
			if (row.kind === "message" && row.snippet && !existing?.snippet) {
				threads.set(id, { snippet: row.snippet, author: row.author })
			} else if (!existing) {
				threads.set(id, {})
			}
		}
	}
	return { threads, tasks, notes }
}

/**
 * A snippet that starts a few characters before the first match, so the hit stays in view in
 * a narrow row (the host's ~120-character window puts it further in).
 */
export function focusSnippet(snippet: string, query: string, lead = 18): string {
	const needle = query.trim().toLowerCase()
	const index = needle ? snippet.toLowerCase().indexOf(needle) : -1
	if (index <= lead) return snippet
	return `…${snippet.slice(index - lead).replace(/^…/, "")}`
}

export type KindChip = "threads" | "tasks" | "notes"
export type StateChip = "active" | "stashed" | "settled"

export const KIND_CHIPS: { id: KindChip; label: string }[] = [
	{ id: "threads", label: "Threads" },
	{ id: "tasks", label: "Tasks" },
	{ id: "notes", label: "Notes" },
]
export const STATE_CHIPS: { id: StateChip; label: string }[] = [
	{ id: "active", label: "Active" },
	{ id: "stashed", label: "Stashed" },
	{ id: "settled", label: "Settled" },
]

/** Chips that are on. An empty group means "all" (nothing narrowed yet). */
export interface ListFilter {
	kinds: ReadonlySet<KindChip>
	states: ReadonlySet<StateChip>
}

export const NO_FILTER: ListFilter = { kinds: new Set(), states: new Set() }

const allows = <T>(set: ReadonlySet<T>, value: T) => set.size === 0 || set.has(value)

export interface FilteredSection {
	id: StateChip
	entries: InboxEntry[]
}

export interface FilteredList {
	sections: FilteredSection[]
	notes: SearchRow[]
	/** Rows shown in all sections (threads, tasks and notes). */
	count: number
}

/**
 * The list narrowed to the search: a thread stays when it matched; a task stays when its title
 * matched or any of its threads did, keeping only the matching threads under it. The chips
 * narrow by kind (Threads / Tasks / Notes) and by section (Active / Stashed / Settled).
 */
export function filterList(inbox: InboxGroups, matches: ListSearchMatches, filter: ListFilter = NO_FILTER): FilteredList {
	const threadOk = (row: InboxRow) => allows(filter.kinds, "threads") && matches.threads.has(row.item.id)
	const keep = (entries: readonly InboxEntry[]): InboxEntry[] =>
		entries.flatMap((entry): InboxEntry[] => {
			if (entry.kind === "thread") return threadOk(entry.row) ? [entry] : []
			const members = entry.row.members.filter(threadOk)
			const ownMatch = allows(filter.kinds, "tasks") && matches.tasks.has(entry.row.group.id)
			if (!ownMatch && members.length === 0) return []
			const row: InboxTaskGroupRow = { ...entry.row, members }
			return [{ kind: "group", row }]
		})
	const sections: FilteredSection[] = (
		[
			{ id: "active", entries: keep(inbox.activeEntries) },
			{ id: "stashed", entries: keep(inbox.stashed) },
			{ id: "settled", entries: keep(inbox.settled) },
		] as FilteredSection[]
	).filter((section) => allows(filter.states, section.id) && section.entries.length > 0)
	const notes = allows(filter.kinds, "notes") ? matches.notes : []
	const count =
		sections.reduce(
			(total, section) =>
				total +
				section.entries.reduce((sum, entry) => sum + 1 + (entry.kind === "group" ? entry.row.members.length : 0), 0),
			0,
		) + notes.length
	return { sections, notes, count }
}

/** A task's members the list shows open: unsettled or still working. */
export function isActiveMember(row: InboxRow): boolean {
	return !row.settled || isRowWorking(row)
}

/**
 * Threads for the narrow strip's chips: the active ones in list order (tasks' threads where the
 * task sits), with the open thread always included even when it's stashed or settled.
 */
export function stripThreads(inbox: InboxGroups, currentId: string | undefined, history: readonly HistoryItem[]): InboxRow[] {
	const rows = inbox.activeEntries.flatMap((entry) =>
		entry.kind === "thread" ? [entry.row] : entry.row.members.filter(isActiveMember),
	)
	if (!currentId || rows.some((row) => row.item.id === currentId)) return rows
	const byId = new Map(history.map((item) => [item.id, item]))
	const topId = topThreadId(currentId, byId)
	const all = [...inbox.stashed, ...inbox.settled, ...inbox.activeEntries].flatMap((entry) =>
		entry.kind === "thread" ? [entry.row] : entry.row.members,
	)
	const current = all.find((row) => row.item.id === topId)
	return current && !rows.includes(current) ? [current, ...rows] : rows
}

/**
 * How many chips fit, with the open thread swapped into the last visible slot when it would
 * otherwise sit in the "+N" overflow.
 */
export function visibleStripChips(rows: readonly InboxRow[], fit: number, currentId: string | undefined): InboxRow[] {
	const count = Math.max(1, fit)
	const shown = rows.slice(0, count)
	const current = currentId ? rows.find((row) => row.item.id === currentId) : undefined
	if (current && !shown.includes(current)) shown[shown.length - 1] = current
	return shown
}
