import { OpenNoteRequest, SearchHistoryRequest, SetThreadTaskGroupRequest } from "@shared/proto/cline/task_group"
import type { TaskGroupSummary } from "@shared/task-groups"
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react"
import { Breadcrumb, type Crumb } from "@/components/chat/task-header/Breadcrumb"
import { openTask } from "@/components/inbox/sessionActions"
import { TaskTagChip } from "@/components/taskGroup/TaskTagChip"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { cn } from "@/lib/utils"
import { TaskGroupServiceClient } from "@/services/grpc-client"
import { findSubstringRegions } from "@/utils/highlight"
import {
	countByKind,
	filterRows,
	fromServerResults,
	mergeResults,
	SEARCH_FILTERS,
	type SearchFilter,
	type SearchResultKind,
	type SearchRow,
	searchLocal,
	suggestTaskGroup,
} from "./searchUtils"

export const SEARCH_DEBOUNCE_MS = 200
// Per server kind; notes and messages are fetched separately so neither crowds out the other.
const SERVER_LIMIT = 25

const KIND_LABEL: Record<SearchResultKind, string> = { task: "Task", thread: "Thread", note: "Note", message: "Message" }
const KIND_ICON: Record<SearchResultKind, string> = { task: "tasklist", thread: "comment", note: "book", message: "quote" }

async function fetchServerRows(query: string): Promise<SearchRow[]> {
	const kinds = ["notes", "messages"] as const
	const responses = await Promise.all(
		kinds.map((kind) =>
			TaskGroupServiceClient.searchHistory(SearchHistoryRequest.create({ query, kind, limit: SERVER_LIMIT })).then(
				(response) => response.results,
				(error) => {
					console.error(`Failed to search ${kind}:`, error)
					return []
				},
			),
		),
	)
	return fromServerResults(responses.flat())
}

/** `text` with every case-insensitive occurrence of `query` marked. */
const Highlighted = ({ text, query }: { text: string; query: string }) => {
	const regions = findSubstringRegions(text, query)
	if (regions.length === 0) return <>{text}</>
	const parts: ReactNode[] = []
	let next = 0
	for (const [start, end] of regions) {
		parts.push(text.slice(next, start))
		parts.push(
			<mark
				className="rounded-[2px] bg-(--vscode-editor-findMatchHighlightBackground) px-px text-foreground"
				data-testid="search-hit"
				key={start}>
				{text.slice(start, end + 1)}
			</mark>,
		)
		next = end + 1
	}
	parts.push(text.slice(next))
	return <>{parts}</>
}

interface SearchViewProps {
	/** What was typed in the home search bar. */
	initialQuery: string
	/** Back to home (also `Esc`). */
	onClose: () => void
}

/**
 * Search across tasks, threads, notebook notes and message text, in one ranked
 * list. Titles and tags are matched here (Fuse); note bodies and messages come
 * from `searchHistory`, debounced, with stale responses dropped.
 */
export const SearchView = ({ initialQuery, onClose }: SearchViewProps) => {
	const { taskHistory, taskGroups, navigateToTaskGroup } = useExtensionState()
	const [query, setQuery] = useState(initialQuery)
	const [filter, setFilter] = useState<SearchFilter>("all")
	const [serverRows, setServerRows] = useState<SearchRow[]>([])
	const [searching, setSearching] = useState(false)
	// Threads filed from this view, so the row flips to "Added ✓" before state round-trips.
	const [added, setAdded] = useState<Record<string, string>>({})
	const requestRef = useRef(0)
	const inputRef = useRef<HTMLInputElement>(null)

	useEffect(() => {
		const input = inputRef.current
		if (!input) return
		input.focus()
		input.setSelectionRange(input.value.length, input.value.length)
	}, [])

	useEffect(() => {
		const request = ++requestRef.current
		const trimmed = query.trim()
		if (!trimmed) {
			setServerRows([])
			setSearching(false)
			return
		}
		setSearching(true)
		const timer = setTimeout(() => {
			fetchServerRows(trimmed).then((rows) => {
				if (request !== requestRef.current) return
				setServerRows(rows)
				setSearching(false)
			})
		}, SEARCH_DEBOUNCE_MS)
		return () => clearTimeout(timer)
	}, [query])

	const groups = taskGroups ?? []
	const groupsById = useMemo(() => new Map(groups.map((group) => [group.id, group])), [groups])
	const localRows = useMemo(() => searchLocal(query, groups, taskHistory ?? []), [query, groups, taskHistory])
	// Server rows belong to the query they were fetched for; hide them once it's cleared.
	const rows = useMemo(() => mergeResults(localRows, query.trim() ? serverRows : []), [localRows, serverRows, query])
	const counts = useMemo(() => countByKind(rows), [rows])
	const visible = useMemo(() => filterRows(rows, filter), [rows, filter])

	const addToTask = (threadId: string, group: TaskGroupSummary) => {
		setAdded((current) => ({ ...current, [threadId]: group.id }))
		TaskGroupServiceClient.setThreadTaskGroup(SetThreadTaskGroupRequest.create({ threadId, taskGroupId: group.id })).catch(
			(error) => {
				console.error("Failed to add thread to task:", error)
				setAdded(({ [threadId]: _, ...rest }) => rest)
			},
		)
	}

	const openRow = (row: SearchRow) => {
		switch (row.kind) {
			case "task":
				onClose()
				navigateToTaskGroup(row.id)
				return
			case "note":
				if (row.taskGroupId) {
					TaskGroupServiceClient.openNote(OpenNoteRequest.create({ taskGroupId: row.taskGroupId, slug: row.id })).catch(
						(error) => console.error("Failed to open note:", error),
					)
				}
				return
			case "thread":
			case "message":
				onClose()
				openTask(row.threadId ?? row.id)
		}
	}

	const crumbs: Crumb[] = [
		{ id: "home", label: "Home", kind: "home", onSelect: onClose },
		{ id: "search", label: "Search", kind: "thread" },
	]

	const renderSubtitle = (row: SearchRow, taskTitle: string | undefined, addedTo: TaskGroupSummary | undefined) => {
		if (row.kind === "message" && row.snippet) {
			return (
				<span className="ph-no-capture truncate">
					“<Highlighted query={query} text={row.snippet} />”
				</span>
			)
		}
		if (row.kind === "note") {
			return row.snippet ? (
				<span className="ph-no-capture truncate">
					<Highlighted query={query} text={row.snippet} />
				</span>
			) : (
				<span className="truncate">{taskTitle ? `${taskTitle} notebook` : "Notebook"}</span>
			)
		}
		const where = addedTo?.title ?? taskTitle
		return (
			<>
				{row.tags?.map((tag) => (
					<TaskTagChip
						detected={tag.source === "auto"}
						key={`${tag.kind}:${tag.value}`}
						kind={tag.kind}
						value={tag.value}
					/>
				))}
				{row.kind === "thread" && (
					<span className="truncate">
						{row.tags?.length ? "· " : ""}
						{where ? `in ${where}` : "not in a task"}
					</span>
				)}
			</>
		)
	}

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: Esc anywhere in the view returns home
		<div
			className="flex min-h-0 flex-1 flex-col overflow-hidden"
			data-testid="search-view"
			onKeyDown={(event) => {
				if (event.key === "Escape") {
					event.preventDefault()
					onClose()
				}
			}}>
			<div className="px-4 pt-2 pb-1">
				<div className="flex h-7.5 items-center gap-1 rounded-xs border border-transparent pl-0.5 pr-1 bg-(--vscode-toolbar-hoverBackground)/40">
					<Breadcrumb crumbs={crumbs} />
				</div>
			</div>
			<div className="flex shrink-0 flex-col gap-1.5 px-5 pt-1.5 pb-1.5">
				<label className="flex h-7 min-w-0 cursor-text items-center gap-1.5 rounded-xs border border-(--vscode-focusBorder) bg-input-background px-2 text-description">
					<span
						aria-hidden
						className={cn(
							"codicon text-[12px]!",
							searching ? "codicon-loading codicon-modifier-spin motion-reduce:animate-none" : "codicon-search",
						)}
					/>
					<input
						aria-label="Search threads, tasks, notes"
						className="min-w-0 flex-1 border-0 bg-transparent p-0 text-xs text-input-foreground outline-none placeholder:text-input-placeholder"
						data-testid="search-input"
						onChange={(event) => setQuery(event.target.value)}
						placeholder="Search threads, tasks, notes…"
						ref={inputRef}
						type="text"
						value={query}
					/>
					<kbd className="shrink-0 rounded-xs border border-input-border px-1 text-[10px] leading-4 text-description">
						esc
					</kbd>
				</label>
				<div className="flex flex-wrap gap-1" role="tablist">
					{SEARCH_FILTERS.map(({ filter: value, label, kind }) => (
						<button
							aria-selected={filter === value}
							className={cn(
								"flex h-5 cursor-pointer items-center gap-1 rounded-full border px-2 text-[11px] focus-visible:outline focus-visible:outline-1 focus-visible:outline-(--vscode-focusBorder)",
								filter === value
									? "border-(--vscode-focusBorder) bg-(--vscode-list-activeSelectionBackground) text-(--vscode-list-activeSelectionForeground)"
									: "border-editor-group-border bg-transparent text-foreground hover:bg-list-hover",
							)}
							data-testid={`search-filter-${value}`}
							key={value}
							onClick={() => setFilter(value)}
							role="tab"
							type="button">
							{label}
							{kind && <span className="opacity-70">{counts[kind]}</span>}
						</button>
					))}
				</div>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
				{query.trim() && (
					<div className="flex items-center gap-1.5 px-2 pt-2.5 pb-1 text-[10.5px] font-medium uppercase tracking-wider text-description">
						{visible.length === 1 ? "1 result" : `${visible.length} results`}
					</div>
				)}
				{query.trim() && visible.length === 0 && !searching && (
					<div className="px-2 py-3 text-xs text-description">No matches.</div>
				)}
				{visible.map((row) => {
					const taskTitle = row.taskGroupId ? groupsById.get(row.taskGroupId)?.title : undefined
					const addedTo = added[row.id] ? groupsById.get(added[row.id]) : undefined
					const loose = row.kind === "thread" && !row.taskGroupId && !added[row.id]
					const suggestion = loose ? suggestTaskGroup(row.tags, groups) : undefined
					return (
						<div
							className={cn(
								"group grid h-11 cursor-pointer grid-cols-[14px_minmax(0,1fr)_auto] items-center gap-2 overflow-hidden rounded-xs border border-transparent px-2 animate-row-in motion-reduce:animate-none",
								"hover:bg-list-hover hover:border-editor-group-border focus-visible:outline focus-visible:outline-1 focus-visible:outline-(--vscode-focusBorder)",
							)}
							data-kind={row.kind}
							data-testid="search-row"
							key={row.kind === "note" ? `note:${row.taskGroupId}:${row.id}` : `${row.kind}:${row.id}`}
							onClick={() => openRow(row)}
							onKeyDown={(event) => {
								if (event.key === "Enter" || event.key === " ") {
									event.preventDefault()
									openRow(row)
								}
							}}
							role="button"
							tabIndex={0}>
							<span
								aria-hidden
								className={cn(
									`codicon codicon-${KIND_ICON[row.kind]} text-[12px]!`,
									row.kind === "task" || row.kind === "note"
										? "text-(--vscode-charts-purple)"
										: "text-description",
								)}
							/>
							<div className="min-w-0">
								<div
									className={cn(
										"ph-no-capture truncate text-sm text-foreground",
										row.kind === "task" && "font-medium",
									)}>
									{row.title}
								</div>
								<div className="flex min-w-0 items-center gap-1 overflow-hidden text-xs text-description">
									{renderSubtitle(row, taskTitle, addedTo)}
								</div>
							</div>
							<div className="flex items-center gap-2">
								{addedTo ? (
									<span className="text-[11px] text-(--vscode-charts-green)">Added ✓</span>
								) : (
									suggestion && (
										<button
											className="flex h-5 shrink-0 cursor-pointer items-center rounded-xs border-0 bg-button-background px-1.5 text-[11px] text-button-foreground hover:bg-button-hover"
											data-testid="search-add-to-task"
											onClick={(event) => {
												event.stopPropagation()
												addToTask(row.id, suggestion)
											}}
											title={`Add to ${suggestion.title}`}
											type="button">
											＋ Add to task
										</button>
									)
								)}
								<span className="text-[10px] uppercase tracking-wide text-description">
									{KIND_LABEL[row.kind]}
								</span>
							</div>
						</div>
					)
				})}
			</div>
		</div>
	)
}

export default SearchView
