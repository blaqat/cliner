import type { HistoryItem } from "@shared/HistoryItem"
import type { TaskGroupSummary, TaskTag, TaskTagKind } from "@shared/task-groups"
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
export type DateRange = "any" | "today" | "7d" | "30d" | "custom"

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
export const DATE_CHIPS: { id: DateRange; label: string }[] = [
	{ id: "any", label: "Any time" },
	{ id: "today", label: "Today" },
	{ id: "7d", label: "7 days" },
	{ id: "30d", label: "30 days" },
	{ id: "custom", label: "Custom" },
]

/** Last activity window. Custom bounds are `yyyy-mm-dd` (local days, both inclusive); either may be blank. */
export interface DateFilter {
	range: DateRange
	from?: string
	to?: string
}

/** Chips that are on. An empty group means "all" (nothing narrowed yet). */
export interface ListFilter {
	kinds: ReadonlySet<KindChip>
	states: ReadonlySet<StateChip>
	/** Tag values (lowercased) picked in the panel: a row needs any of them. */
	tags: ReadonlySet<string>
	date: DateFilter
}

export const NO_FILTER: ListFilter = { kinds: new Set(), states: new Set(), tags: new Set(), date: { range: "any" } }

const allows = <T>(set: ReadonlySet<T>, value: T) => set.size === 0 || set.has(value)

/** The date chip narrows anything (Custom only once it has a bound). */
export function isDateActive(date: DateFilter): boolean {
	return date.range === "custom" ? !!(date.from || date.to) : date.range !== "any"
}

/** How many panel filters are on (each kind, state and tag chip, plus the date). */
export function countFilters(filter: ListFilter): number {
	return filter.kinds.size + filter.states.size + filter.tags.size + (isDateActive(filter.date) ? 1 : 0)
}

const DAY_MS = 86_400_000

function parseDay(value: string | undefined): Date | undefined {
	const match = value ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null
	if (!match) return undefined
	return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
}

/** The window a date filter keeps, as epoch ms (`[start, end]`, inclusive), in local time. */
export function dateBounds(date: DateFilter, now: number): { start: number; end: number } {
	switch (date.range) {
		case "today": {
			const day = new Date(now)
			return { start: new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime(), end: Number.POSITIVE_INFINITY }
		}
		case "7d":
			return { start: now - 7 * DAY_MS, end: Number.POSITIVE_INFINITY }
		case "30d":
			return { start: now - 30 * DAY_MS, end: Number.POSITIVE_INFINITY }
		case "custom": {
			const from = parseDay(date.from)
			const to = parseDay(date.to)
			return {
				start: from ? from.getTime() : Number.NEGATIVE_INFINITY,
				// Through the end of the "to" day.
				end: to ? new Date(to.getFullYear(), to.getMonth(), to.getDate() + 1).getTime() - 1 : Number.POSITIVE_INFINITY,
			}
		}
		default:
			return { start: Number.NEGATIVE_INFINITY, end: Number.POSITIVE_INFINITY }
	}
}

/** The search field split into its text and its `#tag` tokens (lowercased, without the `#`). */
export interface ListQuery {
	text: string
	tags: string[]
}

/** `#tag` tokens in the field filter by tag (a tag starting with the token); the rest is searched as text. */
export function parseListQuery(query: string): ListQuery {
	const words: string[] = []
	const tags: string[] = []
	for (const token of query.trim().split(/\s+/)) {
		if (!token) continue
		if (token.startsWith("#")) {
			const tag = token.slice(1).toLowerCase()
			if (tag && !tags.includes(tag)) tags.push(tag)
		} else {
			words.push(token)
		}
	}
	return { text: words.join(" "), tags }
}

/** The field without its `#tag` tokens (what "Clear filters" leaves behind). */
export function stripTagTokens(query: string): string {
	return parseListQuery(query).text
}

export interface TagInUse {
	/** Lowercased: the filter key. */
	key: string
	/** As first written. */
	value: string
	kind: TaskTagKind
	/** Tasks and threads carrying it. */
	count: number
}

/** Tags on tasks and threads (subagents excluded), one per value, most used first. */
export function tagsInUse(history: readonly HistoryItem[], taskGroups: readonly TaskGroupSummary[]): TagInUse[] {
	const byKey = new Map<string, TagInUse>()
	const add = (tags: readonly TaskTag[] | undefined) => {
		// A value tagged twice on one item (say as a ticket and a label) counts once.
		const seen = new Set<string>()
		for (const tag of tags ?? []) {
			const key = tag.value.trim().toLowerCase()
			if (!key || seen.has(key)) continue
			seen.add(key)
			const entry = byKey.get(key)
			if (entry) entry.count++
			else byKey.set(key, { key, value: tag.value.trim(), kind: tag.kind, count: 1 })
		}
	}
	for (const group of taskGroups) add(group.tags)
	for (const item of history) if (!item.isSubagent) add(item.tags)
	return [...byKey.values()].sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
}

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

export interface FilterOptions {
	/** `#tag` tokens from the field: like picked tags, but a tag only has to start with one. */
	typedTags?: readonly string[]
	/** Clock for the date chips. */
	now?: number
}

/**
 * The list narrowed to the search and the filters. Without `matches` (no search text) every row
 * matches the text. A thread stays when it matched; a task stays when it matched itself or any of
 * its threads did, keeping only the matching threads under it. The chips narrow by kind
 * (Threads / Tasks / Notes), by section (Active / Stashed / Settled), by tag (any picked or typed
 * tag; a thread matches on its own tags or its task's) and by last activity.
 */
export function filterList(
	inbox: InboxGroups,
	matches: ListSearchMatches | undefined,
	filter: ListFilter = NO_FILTER,
	{ typedTags = [], now = Date.now() }: FilterOptions = {},
): FilteredList {
	const byTag = filter.tags.size > 0 || typedTags.length > 0
	const tagsOk = (...lists: (readonly TaskTag[] | undefined)[]) =>
		!byTag ||
		lists.some((tags) =>
			(tags ?? []).some((tag) => {
				const key = tag.value.trim().toLowerCase()
				return filter.tags.has(key) || typedTags.some((typed) => key.startsWith(typed))
			}),
		)
	const { start, end } = dateBounds(filter.date, now)
	const dateOk = (ts: number) => ts >= start && ts <= end

	const threadOk = (row: InboxRow, groupTags?: readonly TaskTag[]) =>
		allows(filter.kinds, "threads") &&
		(!matches || matches.threads.has(row.item.id)) &&
		tagsOk(row.item.tags, groupTags) &&
		dateOk(row.agentActivityTs)
	const keep = (entries: readonly InboxEntry[]): InboxEntry[] =>
		entries.flatMap((entry): InboxEntry[] => {
			if (entry.kind === "thread") return threadOk(entry.row) ? [entry] : []
			const { group } = entry.row
			const members = entry.row.members.filter((member) => threadOk(member, group.tags))
			const ownMatch =
				allows(filter.kinds, "tasks") &&
				(!matches || matches.tasks.has(group.id)) &&
				tagsOk(group.tags) &&
				dateOk(entry.row.agentActivityTs)
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
	// Notes only come from a text search; a note goes by its task's tags.
	const groupTags = new Map(
		[...inbox.activeEntries, ...inbox.stashed, ...inbox.settled].flatMap((entry) =>
			entry.kind === "group" ? [[entry.row.group.id, entry.row.group.tags] as const] : [],
		),
	)
	const notes =
		matches && allows(filter.kinds, "notes")
			? matches.notes.filter(
					(note) => tagsOk(note.taskGroupId ? groupTags.get(note.taskGroupId) : undefined) && dateOk(note.ts),
				)
			: []
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

/** A strip tab: a loose thread, or a task's tab group (its open threads under its name). */
export type StripEntry = { kind: "thread"; row: InboxRow } | { kind: "task"; group: TaskGroupSummary; rows: InboxRow[] }

const entryHas = (entry: StripEntry, id: string) =>
	entry.kind === "thread" ? entry.row.item.id === id : entry.rows.some((row) => row.item.id === id)

/**
 * The top strip's tabs, in list order: each active task as a group of its open threads, and the
 * loose active threads. The open thread is always there, even when it's stashed or settled (in
 * its task's group when it has one).
 */
export function stripEntries(inbox: InboxGroups, currentId: string | undefined, history: readonly HistoryItem[]): StripEntry[] {
	const entries = inbox.activeEntries.map(
		(entry): StripEntry =>
			entry.kind === "thread"
				? { kind: "thread", row: entry.row }
				: { kind: "task", group: entry.row.group, rows: entry.row.members.filter(isActiveMember) },
	)
	if (!currentId) return entries
	const topId = topThreadId(currentId, new Map(history.map((item) => [item.id, item])))
	if (entries.some((entry) => entryHas(entry, topId))) return entries
	for (const entry of [...inbox.activeEntries, ...inbox.stashed, ...inbox.settled]) {
		if (entry.kind === "thread") {
			if (entry.row.item.id === topId) return [{ kind: "thread", row: entry.row }, ...entries]
			continue
		}
		const current = entry.row.members.find((member) => member.item.id === topId)
		if (!current) continue
		const index = entries.findIndex((other) => other.kind === "task" && other.group.id === entry.row.group.id)
		if (index < 0) return [{ kind: "task", group: entry.row.group, rows: [current] }, ...entries]
		const task = entries[index] as Extract<StripEntry, { kind: "task" }>
		return entries.map((other, at) => (at === index ? { ...task, rows: [...task.rows, current] } : other))
	}
	return entries
}

export interface FittedStrip {
	/** Tabs to draw; a task cut short keeps only its first threads (and the open one). */
	shown: StripEntry[]
	/** Threads left for "+N". */
	hidden: number
}

/**
 * Which tabs fit `fit` slots: a thread takes one, a task its name plus one per thread. The open thread always makes it, swapped in at the end when it would overflow.
 */
export function fitStripEntries(entries: readonly StripEntry[], fit: number, currentId: string | undefined): FittedStrip {
	const budget = Math.max(1, fit)
	const cost = (entry: StripEntry) => (entry.kind === "thread" ? 1 : 1 + entry.rows.length)
	const rowsOf = (entry: StripEntry) => (entry.kind === "thread" ? 1 : entry.rows.length)

	const shown: StripEntry[] = []
	let used = 0
	for (const entry of entries) {
		if (used + cost(entry) <= budget) {
			shown.push(entry)
			used += cost(entry)
			continue
		}
		const room = budget - used
		if (entry.kind === "task" && room >= 2) shown.push({ ...entry, rows: entry.rows.slice(0, room - 1) })
		break
	}

	if (currentId && !shown.some((entry) => entryHas(entry, currentId))) {
		const owner = entries.find((entry) => entryHas(entry, currentId))
		if (owner) {
			// Drop a cut-short copy of the owner, then make room at the end.
			const sameEntry = (entry: StripEntry) =>
				owner.kind === "task" ? entry.kind === "task" && entry.group.id === owner.group.id : entry === owner
			const kept = shown.filter((entry) => !sameEntry(entry))
			const needed = owner.kind === "thread" ? 1 : 2
			let total = kept.reduce((sum, entry) => sum + cost(entry), 0)
			while (kept.length > 0 && total + needed > budget) total -= cost(kept.pop() as StripEntry)
			if (owner.kind === "thread") kept.push(owner)
			else {
				const room = Math.max(1, budget - total - 1)
				const current = owner.rows.find((row) => row.item.id === currentId) as InboxRow
				const others = owner.rows.filter((row) => row !== current).slice(0, room - 1)
				// Keep list order inside the group.
				kept.push({ ...owner, rows: owner.rows.filter((row) => row === current || others.includes(row)) })
			}
			shown.splice(0, shown.length, ...kept)
		}
	}

	const total = entries.reduce((sum, entry) => sum + rowsOf(entry), 0)
	const drawn = shown.reduce((sum, entry) => sum + rowsOf(entry), 0)
	return { shown, hidden: total - drawn }
}
