import { type KeyboardEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react"
import { HeaderIconButton } from "@/components/chat/task-header/HeaderIconButton"
import {
	ACTIVE_PAGE_SIZE,
	buildInbox,
	DEFAULT_ACTIVE_LIMIT,
	DEFAULT_SETTLED_LIMIT,
	type InboxEntry,
	SETTLED_PAGE_SIZE,
} from "@/components/inbox/inboxUtils"
import { TaskGroupBlock, TaskGroupMembers, TaskGroupRow } from "@/components/inbox/TaskGroupRow"
import type { SearchRow } from "@/components/search/searchUtils"
import { openNote } from "@/components/taskGroup/useTaskGroup"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { cn } from "@/lib/utils"
import { getCurrentPlatform } from "@/utils/platformUtils"
import { formatListTime, listTimeTitle } from "./listTime"
import { ActiveFilters, FilterPanel } from "./ThreadListFilters"
import { Hit, NoteRow, ROW_ATTR, ThreadRow } from "./ThreadListRows"
import {
	countFilters,
	filterList,
	isActiveMember,
	KIND_CHIPS,
	kindsNeedingText,
	type ListFilter,
	NO_FILTER,
	parseListQuery,
	type StateChip,
	stripTagTokens,
} from "./threadListModel"
import { useListSearch } from "./useListSearch"

const UNLIMITED = Number.MAX_SAFE_INTEGER
const STASHED_KEY = "oneView.stashedCollapsed"
const SETTLED_KEY = "oneView.settledCollapsed"
const TASK_FOLD_KEY = "oneView.taskFolds"

function readFlag(key: string, fallback: boolean): boolean {
	try {
		const value = localStorage.getItem(key)
		return value === null ? fallback : value === "1"
	} catch {
		return fallback
	}
}

function writeFlag(key: string, value: boolean): void {
	try {
		localStorage.setItem(key, value ? "1" : "0")
	} catch {
		// Best effort.
	}
}

/** Tasks the user folded or unfolded in the list (id → expanded). Unlisted ones use their section's default. */
function readTaskFolds(): Record<string, boolean> {
	try {
		const value: unknown = JSON.parse(localStorage.getItem(TASK_FOLD_KEY) ?? "{}")
		return value && typeof value === "object" ? (value as Record<string, boolean>) : {}
	} catch {
		return {}
	}
}

const SECTION_CLASS =
	"flex w-full items-center gap-1.5 border-0 bg-transparent px-2 pt-2.5 pb-1 text-left text-[10.5px] font-medium uppercase tracking-wider text-description"
const MORE_CLASS = "cursor-pointer border-0 bg-transparent p-0 text-xs text-description hover:text-foreground"
const LINK_CLASS = "cursor-pointer border-0 bg-transparent p-0 text-xs text-link hover:text-link-hover"

export interface ThreadListProps {
	currentThreadId?: string
	currentTaskGroupId?: string
	onOpenThread: (threadId: string) => void
	onOpenTaskGroup: (taskGroupId: string) => void
	/** Leading header control: the dock grip. */
	grip?: ReactNode
	/** Bumped to focus the search field (⌘K / Ctrl+K, the strip's search button). */
	focusSearchSignal?: number
	/** Esc with nothing to clear (the strip's dropdown closes on it). */
	onEscape?: () => void
	/** Clock override for tests and stories. */
	now?: number
}

/**
 * One view's thread list: search and filters (both narrow the list in place; `#tag` in the field
 * filters by tag), then the active tasks and threads, a collapsed Stashed section and a collapsed,
 * paged Settled one. Each thread row shows its status and last line; hovering adds Stash and Settle.
 */
export const ThreadList = ({
	currentThreadId,
	currentTaskGroupId,
	onOpenThread,
	onOpenTaskGroup,
	grip,
	focusSearchSignal,
	onEscape,
	now = Date.now(),
}: ThreadListProps) => {
	const { taskHistory, sessionStatuses, subagentCounts, taskGroups } = useExtensionState()
	const [query, setQuery] = useState("")
	const [filterOpen, setFilterOpen] = useState(false)
	const [filter, setFilter] = useState<ListFilter>(NO_FILTER)
	const [activeLimit, setActiveLimit] = useState(DEFAULT_ACTIVE_LIMIT)
	const [settledLimit, setSettledLimit] = useState(DEFAULT_SETTLED_LIMIT)
	const [stashedLimit, setStashedLimit] = useState(DEFAULT_SETTLED_LIMIT)
	const [stashedCollapsed, setStashedCollapsed] = useState(() => readFlag(STASHED_KEY, true))
	const [settledCollapsed, setSettledCollapsed] = useState(() => readFlag(SETTLED_KEY, true))
	const [taskFolds, setTaskFolds] = useState(readTaskFolds)
	// Tasks whose settled threads are shown too (this session only).
	const [showSettledIn, setShowSettledIn] = useState<ReadonlySet<string>>(new Set())
	const inputRef = useRef<HTMLInputElement>(null)
	const bodyRef = useRef<HTMLDivElement>(null)

	// `#tag` tokens filter by tag; only the rest is searched as text.
	const parsed = useMemo(() => parseListQuery(query), [query])
	const search = useListSearch(parsed.text)
	const text = parsed.text
	// Panel filters plus typed `#tags`: what "Clear filters" resets.
	const filterCount = countFilters(filter) + parsed.tags.length
	// Search text, a `#tag` or any chip narrows the list; the full list otherwise.
	const filtering = search.active || filterCount > 0
	const history = useMemo(() => taskHistory ?? [], [taskHistory])
	const inbox = useMemo(
		() =>
			buildInbox(history, sessionStatuses, subagentCounts, {
				activeLimit: filtering ? UNLIMITED : activeLimit,
				settledLimit: filtering ? UNLIMITED : settledLimit,
				stashedLimit: filtering ? UNLIMITED : stashedLimit,
				taskGroups,
			}),
		[history, sessionStatuses, subagentCounts, taskGroups, filtering, activeLimit, settledLimit, stashedLimit],
	)
	const filtered = useMemo(
		() =>
			filtering
				? filterList(inbox, search.active ? search.matches : undefined, filter, { typedTags: parsed.tags, now })
				: undefined,
		[filtering, inbox, search.active, search.matches, filter, parsed.tags, now],
	)

	// The thread on screen may be an aside or subagent: its top-level row is the one highlighted.
	const currentRowId = useMemo(() => {
		if (!currentThreadId) return undefined
		const byId = new Map(history.map((item) => [item.id, item]))
		let id = currentThreadId
		const seen = new Set<string>()
		for (
			let parent = byId.get(id)?.parentTaskId;
			parent && byId.has(parent) && !seen.has(parent);
			parent = byId.get(id)?.parentTaskId
		) {
			seen.add(parent)
			id = parent
		}
		return id
	}, [currentThreadId, history])
	const currentGroupId = currentRowId ? history.find((item) => item.id === currentRowId)?.taskGroupId : undefined

	useEffect(() => {
		if (!focusSearchSignal) return
		inputRef.current?.focus()
		inputRef.current?.select()
	}, [focusSearchSignal])

	// The open thread or task stays in view as it changes.
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-run when what's open changes
	useEffect(() => {
		bodyRef.current?.querySelector<HTMLElement>("[data-current]")?.scrollIntoView?.({ block: "nearest" })
	}, [currentRowId, currentTaskGroupId])

	const changeQuery = (next: string) => setQuery(next)

	// Chips off and `#tags` out of the field; the search text stays.
	const clearFilters = () => {
		setFilter(NO_FILTER)
		setQuery((current) => (parseListQuery(current).tags.length ? stripTagTokens(current) : current))
	}

	const toggleFilterPanel = () =>
		setFilterOpen((open) => {
			// The panel sits at the top of the list's scroll area.
			if (!open) bodyRef.current?.scrollTo?.({ top: 0 })
			return !open
		})

	const toggleSection = (key: string, set: (update: (value: boolean) => boolean) => void) =>
		set((collapsed) => {
			writeFlag(key, !collapsed)
			return !collapsed
		})

	const isExpanded = (id: string, sectionDefault: boolean) =>
		filtering || id === currentGroupId || (taskFolds[id] ?? sectionDefault)
	const toggleTask = (id: string, expanded: boolean) =>
		setTaskFolds((current) => {
			const next = { ...current, [id]: !expanded }
			try {
				localStorage.setItem(TASK_FOLD_KEY, JSON.stringify(next))
			} catch {
				// Best effort.
			}
			return next
		})

	// A row found another way doesn't quote a message it isn't there for.
	const hitFor = (id: string) =>
		filter.kinds.size === 0 || filter.kinds.has("messages") ? search.matches.threads.get(id) : undefined

	const openNoteRow = (row: SearchRow) => {
		if (row.taskGroupId) openNote(row.taskGroupId, row.id)
	}

	const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key === "Escape" && event.target !== inputRef.current && onEscape) {
			event.preventDefault()
			onEscape()
			return
		}
		if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return
		const rows = Array.from(bodyRef.current?.querySelectorAll<HTMLElement>(`[${ROW_ATTR}]`) ?? [])
		if (rows.length === 0) return
		const target = event.target as HTMLElement
		if (target === inputRef.current) {
			if (event.key === "ArrowDown") {
				event.preventDefault()
				rows[0].focus()
			}
			return
		}
		const index = rows.indexOf(target)
		if (index < 0) return
		event.preventDefault()
		const next = event.key === "ArrowDown" ? index + 1 : index - 1
		if (next < 0) inputRef.current?.focus()
		else rows[Math.min(next, rows.length - 1)].focus()
	}

	const renderEntries = (entries: readonly InboxEntry[], section: StateChip) =>
		entries.map((entry) => {
			if (entry.kind === "thread") {
				return (
					<ThreadRow
						current={entry.row.item.id === currentRowId}
						hit={hitFor(entry.row.item.id)}
						key={entry.row.item.id}
						now={now}
						onOpen={onOpenThread}
						query={text}
						row={entry.row}
					/>
				)
			}
			const { group, members } = entry.row
			const settled = section === "settled"
			const expanded = isExpanded(group.id, section === "active")
			const showAll = filtering || showSettledIn.has(group.id)
			const shown = showAll ? members : members.filter(isActiveMember)
			const hiddenSettled = members.length - shown.length
			return (
				<TaskGroupBlock
					expanded={expanded}
					key={`group:${group.id}`}
					spine={shown.length > 0 || hiddenSettled > 0}
					testId="one-view-task">
					<TaskGroupRow
						current={group.id === currentTaskGroupId}
						expanded={expanded}
						now={now}
						onOpen={() => onOpenTaskGroup(group.id)}
						onToggle={() => toggleTask(group.id, expanded)}
						row={entry.row}
						rowAttrs={{ [ROW_ATTR]: "" }}
						settled={settled}
						testId="one-view-task-row"
						time={{ text: formatListTime(entry.row.activityTs, now), title: listTimeTitle(entry.row, now) }}
						titleNode={text ? <Hit query={text} text={group.title} /> : undefined}
					/>
					{expanded && (shown.length > 0 || hiddenSettled > 0) && (
						<TaskGroupMembers testId="one-view-task-members">
							{shown.map((member) => (
								<ThreadRow
									current={member.item.id === currentRowId}
									hit={hitFor(member.item.id)}
									key={member.item.id}
									now={now}
									onOpen={onOpenThread}
									query={text}
									row={member}
								/>
							))}
							{hiddenSettled > 0 && (
								<button
									className={cn(MORE_CLASS, "px-2 py-0.5 text-[11px]")}
									onClick={() => setShowSettledIn((current) => new Set([...current, group.id]))}
									type="button">
									Show {hiddenSettled} settled
								</button>
							)}
						</TaskGroupMembers>
					)}
				</TaskGroupBlock>
			)
		})

	const sectionHeader = (
		label: string,
		count: number,
		collapse?: { collapsed: boolean; onToggle: () => void },
		extra?: ReactNode,
	) =>
		collapse ? (
			<button
				aria-expanded={!collapse.collapsed}
				aria-label={`${collapse.collapsed ? "Expand" : "Collapse"} ${label.toLowerCase()}`}
				className={cn(SECTION_CLASS, "cursor-pointer hover:text-foreground")}
				onClick={collapse.onToggle}
				type="button">
				<span
					aria-hidden
					className={cn(
						"codicon codicon-chevron-down text-[12px]! transition-transform duration-150 motion-reduce:transition-none",
						collapse.collapsed && "-rotate-90",
					)}
				/>
				<span>{label}</span>
				<span className="opacity-70">{count}</span>
				{extra}
			</button>
		) : (
			<div className={SECTION_CLASS}>
				<span>{label}</span>
				<span className="opacity-70">{count}</span>
			</div>
		)

	const sectionLabel: Record<StateChip, string> = { active: "Active", stashed: "Stashed", settled: "Settled" }
	const isEmpty = inbox.activeEntries.length === 0 && inbox.stashedTotal === 0 && inbox.settledTotal === 0
	const shortcut = getCurrentPlatform() === "mac" ? "⌘K" : "Ctrl+K"
	const trimmed = query.trim()

	// The panel is the first thing in the list's scroll area, so the menu never has two scrollbars.
	const filterPanel = filterOpen && (
		<FilterPanel canClear={filterCount > 0} filter={filter} onChange={setFilter} onClear={clearFilters} />
	)

	// Why nothing is shown, and the way back.
	const needText = text
		? []
		: KIND_CHIPS.filter((kind) => kindsNeedingText(filter).includes(kind.id)).map((kind) => kind.label.toLowerCase())
	const noMatches = (
		<div className="flex flex-col items-start gap-1 px-2 py-3 text-xs text-description" data-testid="one-view-no-matches">
			<span>
				{needText.length > 0 ? (
					`Type to search ${needText.join(" and ")}.`
				) : (
					<>
						{text ? `No matches for “${text}”` : "No threads, tasks or notes match"}
						{filterCount > 0 ? " with these filters" : ""}.
					</>
				)}
			</span>
			<span className="flex gap-3">
				{text && (
					<button
						className={LINK_CLASS}
						onClick={() => changeQuery(parsed.tags.map((tag) => `#${tag}`).join(" "))}
						type="button">
						Clear search
					</button>
				)}
				{filterCount > 0 && (
					<button className={LINK_CLASS} data-testid="one-view-no-matches-clear" onClick={clearFilters} type="button">
						Clear filters
					</button>
				)}
			</span>
		</div>
	)

	const body = filtered ? (
		<>
			{filterPanel}
			{filtered.sections.map((section) => (
				<div data-section={section.id} key={section.id}>
					{/* Active rows just sit at the top. */}
					{section.id !== "active" &&
						sectionHeader(sectionLabel[section.id], section.entries.length, {
							collapsed: section.id === "stashed" ? stashedCollapsed : settledCollapsed,
							onToggle: () =>
								section.id === "stashed"
									? toggleSection(STASHED_KEY, setStashedCollapsed)
									: toggleSection(SETTLED_KEY, setSettledCollapsed),
						})}
					{(section.id === "active" || !(section.id === "stashed" ? stashedCollapsed : settledCollapsed)) &&
						renderEntries(section.entries, section.id)}
				</div>
			))}
			{filtered.notes.length > 0 && (
				<div data-section="notes">
					{sectionHeader("Notes", filtered.notes.length)}
					{filtered.notes.map((row) => (
						<NoteRow key={`note:${row.taskGroupId}:${row.id}`} onOpen={openNoteRow} query={text} row={row} />
					))}
				</div>
			)}
			{filtered.count === 0 &&
				(search.searching ? <div className="px-2 py-3 text-xs text-description">Searching…</div> : noMatches)}
		</>
	) : isEmpty ? (
		<>
			{filterPanel}
			<div className="px-2 py-3 text-xs text-description" data-testid="one-view-empty">
				No threads yet — start one in the composer.
			</div>
		</>
	) : (
		<>
			{filterPanel}
			<div data-section="active">
				{inbox.activeEntries.length > 0 ? (
					renderEntries(inbox.activeEntries, "active")
				) : (
					<div className="px-2 py-1.5 text-xs text-description">Nothing active.</div>
				)}
				{inbox.hiddenCount > 0 && (
					<button
						className={cn(MORE_CLASS, "px-2 py-1")}
						onClick={() => setActiveLimit((limit) => limit + ACTIVE_PAGE_SIZE)}
						type="button">
						Show more ({inbox.hiddenCount})
					</button>
				)}
			</div>
			{inbox.stashedTotal > 0 && (
				<div data-section="stashed">
					{sectionHeader(
						"Stashed",
						inbox.stashedTotal,
						{ collapsed: stashedCollapsed, onToggle: () => toggleSection(STASHED_KEY, setStashedCollapsed) },
						inbox.stashedNeedingYou > 0 && (
							<span
								className="flex items-center gap-1 normal-case tracking-normal text-warning"
								data-testid="one-view-stashed-attention"
								title={`${inbox.stashedNeedingYou} stashed thread${inbox.stashedNeedingYou === 1 ? " needs" : "s need"} you`}>
								<span className="size-1.5 rounded-full bg-current" />
								{inbox.stashedNeedingYou}
							</span>
						),
					)}
					{!stashedCollapsed && (
						<>
							{renderEntries(inbox.stashed, "stashed")}
							{inbox.stashedTotal > inbox.stashed.length && (
								<button
									className={cn(MORE_CLASS, "px-2 py-1")}
									onClick={() => setStashedLimit((limit) => limit + SETTLED_PAGE_SIZE)}
									type="button">
									Show more ({inbox.stashedTotal - inbox.stashed.length})
								</button>
							)}
						</>
					)}
				</div>
			)}
			{inbox.settledTotal > 0 && (
				<div data-section="settled">
					{sectionHeader("Settled", inbox.settledTotal, {
						collapsed: settledCollapsed,
						onToggle: () => toggleSection(SETTLED_KEY, setSettledCollapsed),
					})}
					{!settledCollapsed && (
						<>
							{renderEntries(inbox.settled, "settled")}
							{(inbox.settledTotal > inbox.settled.length || settledLimit > DEFAULT_SETTLED_LIMIT) && (
								<div className="flex gap-3 px-2 py-1">
									{inbox.settledTotal > inbox.settled.length && (
										<button
											className={MORE_CLASS}
											onClick={() => setSettledLimit((limit) => limit + SETTLED_PAGE_SIZE)}
											type="button">
											Show more ({inbox.settledTotal - inbox.settled.length})
										</button>
									)}
									{settledLimit > DEFAULT_SETTLED_LIMIT && (
										<button
											className={MORE_CLASS}
											onClick={() => setSettledLimit(DEFAULT_SETTLED_LIMIT)}
											type="button">
											Show fewer
										</button>
									)}
								</div>
							)}
						</>
					)}
				</div>
			)}
		</>
	)

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: ↑/↓ move between the rows inside
		<div className="flex min-h-0 flex-1 flex-col" data-testid="one-view-thread-list" onKeyDown={onListKeyDown}>
			<div className="flex shrink-0 items-center gap-1 px-2 pt-2 pb-1.5">
				{grip}
				<label
					className={cn(
						"flex h-6 min-w-0 flex-1 cursor-text items-center gap-1.5 rounded-xs border bg-input-background px-1.5 text-description focus-within:border-(--vscode-focusBorder)",
						trimmed ? "border-(--vscode-focusBorder)" : "border-transparent",
					)}>
					<span
						aria-hidden
						className={cn(
							"codicon text-[12px]!",
							search.searching
								? "codicon-loading codicon-modifier-spin motion-reduce:animate-none"
								: "codicon-search",
						)}
					/>
					<input
						aria-label="Search threads, tasks, notes"
						className="min-w-0 flex-1 border-0 bg-transparent p-0 text-xs text-input-foreground outline-none placeholder:text-input-placeholder"
						data-testid="one-view-search"
						onChange={(event) => changeQuery(event.target.value)}
						onKeyDown={(event) => {
							if (event.key !== "Escape") return
							event.preventDefault()
							event.stopPropagation()
							if (query || filterCount > 0 || filterOpen) {
								setQuery("")
								setFilter(NO_FILTER)
								setFilterOpen(false)
							} else onEscape?.()
						}}
						placeholder="Search"
						ref={inputRef}
						title={`Search threads, tasks, notes (${shortcut})`}
						type="text"
						value={query}
					/>
					{query && (
						<button
							aria-label="Clear search"
							className="flex shrink-0 cursor-pointer items-center border-0 bg-transparent p-0 text-description hover:text-foreground"
							onClick={() => {
								changeQuery("")
								inputRef.current?.focus()
							}}
							type="button">
							<span aria-hidden className="codicon codicon-close text-[12px]!" />
						</button>
					)}
				</label>
				<HeaderIconButton
					aria-pressed={filterOpen}
					className={cn((filterOpen || filterCount > 0) && "bg-toolbar-hover text-foreground")}
					data-testid="one-view-filter"
					icon={filterCount > 0 || filterOpen ? "filter-filled" : "filter"}
					label="Filter results"
					onClick={toggleFilterPanel}
					tooltip="Choose what to search, or filter by state or last activity"
				/>
				{filterCount > 0 && (
					<span className="text-[11px] text-description" data-testid="one-view-filter-count">
						{filterCount}
					</span>
				)}
			</div>
			{!filterOpen && <ActiveFilters filter={filter} onChange={setFilter} onClear={clearFilters} />}
			<div
				className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1 pb-2"
				data-testid="one-view-list-body"
				ref={bodyRef}>
				{body}
			</div>
		</div>
	)
}
