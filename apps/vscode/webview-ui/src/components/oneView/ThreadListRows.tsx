import { CheckIcon, RotateCcwIcon } from "lucide-react"
import type { KeyboardEvent, ReactNode } from "react"
import {
	activityTitle,
	formatAge,
	formatStamp,
	type InboxRow,
	type InboxTaskGroupRow,
	isRowWorking,
} from "@/components/inbox/inboxUtils"
import { SessionStatusIcon } from "@/components/inbox/SessionStatusIcon"
import { toggleTaskSettled, toggleTaskStashed } from "@/components/inbox/sessionActions"
import { threadStatusLabel } from "@/components/inbox/threadStatus"
import type { SearchRow } from "@/components/search/searchUtils"
import { cn } from "@/lib/utils"
import { findSubstringRegions } from "@/utils/highlight"
import { focusSnippet, type RowLine, rowLine, type ThreadHit } from "./threadListModel"

/** Focusable list row: ↑/↓ move between these, Enter/Space opens. */
export const ROW_ATTR = "data-list-row"

const ROW_CLASS =
	"group relative cursor-pointer rounded-xs px-2 outline-none hover:bg-list-hover focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-(--vscode-focusBorder)"

const WHO_CLASS: Record<RowLine["kind"], string> = {
	you: "text-link",
	agent: "text-success",
	ask: "text-warning",
	working: "",
	plain: "",
}

const activate = (open: () => void) => (event: KeyboardEvent) => {
	if (event.target !== event.currentTarget) return
	if (event.key === "Enter" || event.key === " ") {
		event.preventDefault()
		open()
	}
}

/** `text` with each case-insensitive hit of `query` in bold. */
export const Hit = ({ text, query }: { text: string; query: string }) => {
	const regions = findSubstringRegions(text, query)
	if (regions.length === 0) return <>{text}</>
	const parts: ReactNode[] = []
	let next = 0
	for (const [start, end] of regions) {
		parts.push(text.slice(next, start))
		parts.push(
			<mark className="bg-transparent font-bold text-foreground" data-testid="one-view-hit" key={start}>
				{text.slice(start, end + 1)}
			</mark>,
		)
		next = end + 1
	}
	parts.push(text.slice(next))
	return <>{parts}</>
}

/** Spinner, ● waiting for you, ✓ done, the error dot, or the subagents hourglass. */
export const RowStatusIcon = ({ row }: { row: InboxRow }) => {
	if (row.status === "done" && !row.settled) {
		return <CheckIcon aria-label="Done" className="size-3 shrink-0 text-success" role="img" />
	}
	const label =
		row.status === "subagents"
			? threadStatusLabel({
					status: row.status,
					liveSubagents: row.liveSubagentCount,
					liveSubthreads: row.liveSubthreadCount,
					attentionSubagents: row.attentionSubagentCount,
				})
			: undefined
	return (
		<SessionStatusIcon
			className={row.status === "waiting" ? "size-2" : undefined}
			label={label}
			settled={row.settled}
			status={row.status}
		/>
	)
}

const HOVER_BUTTON_CLASS =
	"flex h-4.5 cursor-pointer items-center gap-1 whitespace-nowrap rounded-xs border border-editor-group-border bg-button-secondary-background px-1.5 text-[10px] text-button-secondary-foreground hover:bg-button-secondary-background-hover focus-visible:outline focus-visible:outline-1 focus-visible:outline-(--vscode-focusBorder)"

interface ThreadRowProps {
	row: InboxRow
	now: number
	current: boolean
	onOpen: (threadId: string) => void
	/** What matched while searching. */
	hit?: ThreadHit
	query?: string
}

/** Status, title and time over the last line ("You: …", "Agent: …", "Needs you: …"); hover adds Stash and Settle. */
export const ThreadRow = ({ row, now, current, onOpen, hit, query = "" }: ThreadRowProps) => {
	const { item, settled, activityTs } = row
	const title = item.title?.trim() || item.task
	const line = rowLine(row, now)
	const open = () => onOpen(item.id)
	const snippet = hit?.snippet ? focusSnippet(hit.snippet, query) : undefined
	return (
		<div
			{...{ [ROW_ATTR]: "" }}
			aria-current={current ? "true" : undefined}
			className={cn(
				ROW_CLASS,
				"grid grid-cols-[14px_minmax(0,1fr)] gap-x-2 py-1",
				current && "bg-selection/40",
				settled && "opacity-55 hover:opacity-90",
			)}
			data-current={current || undefined}
			data-status={row.status}
			data-testid="one-view-row"
			data-thread-id={item.id}
			onClick={open}
			onKeyDown={activate(open)}
			role="button"
			tabIndex={0}>
			<div className="flex h-4.5 items-center justify-center">
				<RowStatusIcon row={row} />
			</div>
			<div className="min-w-0">
				<div className="flex min-w-0 items-baseline gap-1.5">
					<span className="ph-no-capture min-w-0 flex-1 truncate text-[13px] text-foreground">
						{query ? <Hit query={query} text={title} /> : title}
					</span>
					<span
						className="shrink-0 text-[10px] text-description tabular-nums group-hover:invisible group-focus-within:invisible"
						data-testid="one-view-row-time"
						title={activityTitle(row, now)}>
						{settled ? formatStamp(activityTs, now) : formatAge(activityTs, now)}
					</span>
				</div>
				<div className="ph-no-capture truncate text-[11px] leading-4 text-description" data-testid="one-view-row-line">
					{snippet ? (
						<>
							{hit?.author && (
								<span className={cn("font-medium", WHO_CLASS[hit.author])}>
									{hit.author === "you" ? "You:" : "Agent:"}{" "}
								</span>
							)}
							<Hit query={query} text={snippet} />
						</>
					) : (
						<span
							className={cn(
								line.kind === "ask" && !line.prefix && "text-warning",
								line.kind === "working" &&
									"animate-shimmer bg-linear-90 from-foreground to-description bg-[length:200%_100%] bg-clip-text text-transparent motion-reduce:animate-none motion-reduce:text-description",
							)}>
							{line.prefix && <span className={cn("font-medium", WHO_CLASS[line.kind])}>{line.prefix} </span>}
							{line.text}
						</span>
					)}
				</div>
			</div>
			{/* Over the time slot on hover or focus, like the home inbox's row actions. */}
			<div className="pointer-events-none absolute top-1 right-1 flex items-center gap-1 opacity-0 transition-opacity duration-150 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 motion-reduce:transition-none">
				<button
					aria-label={`${item.isStashed ? "Unstash" : "Stash"} ${title}`}
					className={HOVER_BUTTON_CLASS}
					onClick={(event) => {
						event.stopPropagation()
						void toggleTaskStashed(item.id)
					}}
					type="button">
					<span aria-hidden className="codicon codicon-archive text-[10px]!" />
					{item.isStashed ? "Unstash" : "Stash"}
				</button>
				<button
					aria-label={`${settled ? "Unsettle" : "Settle"} ${title}`}
					className={HOVER_BUTTON_CLASS}
					onClick={(event) => {
						event.stopPropagation()
						void toggleTaskSettled(item.id)
					}}
					type="button">
					{settled ? <RotateCcwIcon className="size-2.5" /> : <CheckIcon className="size-2.5" />}
					{settled ? "Unsettle" : "Settle"}
				</button>
			</div>
		</div>
	)
}

interface TaskRowProps {
	row: InboxTaskGroupRow
	now: number
	current: boolean
	expanded: boolean
	onToggle: () => void
	onOpen: (taskGroupId: string) => void
	settled?: boolean
	query?: string
}

/** A task: its icon and title (opens the task page), what its threads are doing, and a fold chevron. */
export const TaskRow = ({ row, now, current, expanded, onToggle, onOpen, settled = false, query = "" }: TaskRowProps) => {
	const { group, members, activityTs } = row
	const waiting = members.filter((member) => member.status === "waiting").length
	const running = members.filter(isRowWorking).length
	const open = () => onOpen(group.id)
	return (
		<div
			{...{ [ROW_ATTR]: "" }}
			aria-current={current ? "page" : undefined}
			className={cn(
				ROW_CLASS,
				"grid h-7 grid-cols-[14px_minmax(0,1fr)_auto] items-center gap-x-2",
				current && "bg-selection/40",
				settled && "opacity-55 hover:opacity-90",
			)}
			data-current={current || undefined}
			data-task-id={group.id}
			data-testid="one-view-task-row"
			onClick={open}
			onKeyDown={activate(open)}
			role="button"
			tabIndex={0}>
			<span aria-hidden className="codicon codicon-tasklist text-[12px]! text-(--vscode-charts-purple)" />
			<span className="ph-no-capture min-w-0 truncate text-[13px] font-medium text-foreground">
				{query ? <Hit query={query} text={group.title} /> : group.title}
			</span>
			<span className="flex items-center gap-1.5">
				{!expanded && waiting > 0 && (
					<span aria-label={`${waiting} waiting for you`} className="size-1.5 rounded-full bg-warning" role="img" />
				)}
				{!expanded && running > 0 && <span className="text-[10px] text-link">{running} running</span>}
				<span className="text-[10px] text-description tabular-nums" title={activityTitle(row, now)}>
					{settled ? formatStamp(activityTs, now) : formatAge(activityTs, now)}
				</span>
				<button
					aria-expanded={expanded}
					aria-label={`${expanded ? "Collapse" : "Expand"} ${group.title}`}
					className="flex size-4 cursor-pointer items-center justify-center rounded-xs border-0 bg-transparent p-0 text-description hover:bg-toolbar-hover hover:text-foreground focus-visible:outline focus-visible:outline-1 focus-visible:outline-(--vscode-focusBorder)"
					onClick={(event) => {
						event.stopPropagation()
						onToggle()
					}}
					type="button">
					<span
						aria-hidden
						className={cn(
							"codicon codicon-chevron-down text-[12px]! transition-transform duration-150 motion-reduce:transition-none",
							!expanded && "-rotate-90",
						)}
					/>
				</button>
			</span>
		</div>
	)
}

/** A notebook note that matched the search; opens the note. */
export const NoteRow = ({ row, query, onOpen }: { row: SearchRow; query: string; onOpen: (row: SearchRow) => void }) => {
	const open = () => onOpen(row)
	return (
		<div
			{...{ [ROW_ATTR]: "" }}
			className={cn(ROW_CLASS, "grid grid-cols-[14px_minmax(0,1fr)] gap-x-2 py-1")}
			data-testid="one-view-note-row"
			onClick={open}
			onKeyDown={activate(open)}
			role="button"
			tabIndex={0}>
			<span
				aria-hidden
				className="codicon codicon-book flex h-4.5 items-center text-[12px]! text-(--vscode-charts-purple)"
			/>
			<div className="min-w-0">
				<div className="ph-no-capture truncate text-[13px] text-foreground">
					<Hit query={query} text={row.title} />
				</div>
				{row.snippet && (
					<div className="ph-no-capture truncate text-[11px] leading-4 text-description">
						<Hit query={query} text={focusSnippet(row.snippet, query)} />
					</div>
				)}
			</div>
		</div>
	)
}
