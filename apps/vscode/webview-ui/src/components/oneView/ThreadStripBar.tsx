import { type ReactNode, useLayoutEffect, useRef, useState } from "react"
import { HeaderIconButton } from "@/components/chat/task-header/HeaderIconButton"
import type { InboxRow } from "@/components/inbox/inboxUtils"
import { cn } from "@/lib/utils"
import { RowStatusIcon } from "./ThreadListRows"
import { fitStripEntries, type StripEntry } from "./threadListModel"

/** Room one chip takes in the strip, and what the "+N" chip keeps free. */
export const STRIP_CHIP_SLOT = 104
const OVERFLOW_ROOM = 34

interface ThreadStripBarProps {
	entries: readonly StripEntry[]
	/** The open thread's top-level row id. */
	currentRowId?: string
	onOpenThread: (threadId: string) => void
	/** The ☰ dropdown (the full list with search) is open. */
	listOpen: boolean
	onToggleList: () => void
	/** Opens the dropdown with its search field focused. */
	onSearch: () => void
	/** The dock grip (wide webviews only). */
	grip?: ReactNode
}

/**
 * The narrow layout's list: ☰ (the full list as a dropdown), one row of thread chips (status and a
 * short title, the open one highlighted, the rest behind "+N"), then search.
 */
export const ThreadStripBar = ({
	entries,
	currentRowId,
	onOpenThread,
	listOpen,
	onToggleList,
	onSearch,
	grip,
}: ThreadStripBarProps) => {
	const chipsRef = useRef<HTMLDivElement>(null)
	const [chipsWidth, setChipsWidth] = useState(0)

	useLayoutEffect(() => {
		const element = chipsRef.current
		if (!element) return
		setChipsWidth(element.clientWidth)
		const observer = new ResizeObserver((entries) => {
			const entry = entries[0]
			if (entry) setChipsWidth(entry.contentRect.width)
		})
		observer.observe(element)
		return () => observer.disconnect()
	}, [])

	const room = chipsWidth > 0 ? chipsWidth : STRIP_CHIP_SLOT * 3
	const totalSlots = entries.reduce((sum, entry) => sum + (entry.kind === "thread" ? 1 : 1 + entry.rows.length), 0)
	const fitAll = Math.floor(room / STRIP_CHIP_SLOT)
	const fit = totalSlots <= fitAll ? totalSlots : Math.floor((room - OVERFLOW_ROOM) / STRIP_CHIP_SLOT)
	const { shown, hidden: overflow } = fitStripEntries(entries, fit, currentRowId)

	// Same chip and bracket styling as the chat's aside ThreadStrip.
	const threadTab = (row: InboxRow, inGroup = false) => {
		const title = row.item.title?.trim() || row.item.task
		const current = row.item.id === currentRowId
		return (
			<button
				aria-current={current ? "true" : undefined}
				className={cn(
					"flex min-w-0 max-w-30 shrink cursor-pointer items-center gap-1 rounded-xs border px-1.5 text-[11px] focus-visible:outline focus-visible:outline-1 focus-visible:outline-(--vscode-focusBorder)",
					inGroup ? "h-4.5" : "h-5.5",
					current
						? "border-(--vscode-focusBorder) bg-selection/40 text-foreground"
						: "border-editor-group-border bg-input-background/50 text-description hover:bg-list-hover hover:text-foreground",
				)}
				data-testid="one-view-strip-chip"
				key={row.item.id}
				onClick={() => onOpenThread(row.item.id)}
				title={title}
				type="button">
				<RowStatusIcon row={row} />
				<span className="ph-no-capture min-w-0 truncate">{title}</span>
			</button>
		)
	}

	return (
		<div
			className="flex h-8 min-w-0 shrink-0 items-center gap-0.5 border-b border-editor-group-border bg-background px-1.5"
			data-testid="one-view-strip">
			{grip}
			<HeaderIconButton
				aria-expanded={listOpen}
				aria-haspopup="dialog"
				className={cn(listOpen && "bg-toolbar-hover text-foreground")}
				data-testid="one-view-strip-menu"
				icon="menu"
				label="All threads and search"
				onClick={onToggleList}
			/>
			<div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden" ref={chipsRef}>
				{entries.length === 0 && (
					<button
						className="truncate border-0 bg-transparent px-1 text-[11px] text-description cursor-pointer"
						onClick={onToggleList}
						type="button">
						No active threads. Open all threads
					</button>
				)}
				{shown.map((entry) =>
					entry.kind === "thread" ? (
						threadTab(entry.row)
					) : (
						<div
							aria-label={entry.group.title}
							className="flex min-w-0 shrink items-center gap-0.5 rounded-xs border border-editor-group-border bg-input-background/20 p-px"
							data-testid="one-view-strip-task"
							key={entry.group.id}
							role="group">
							<span
								className="flex min-w-0 max-w-30 shrink items-center gap-1 px-1 text-[11px] text-description"
								title={entry.group.title}>
								<span aria-hidden className="codicon codicon-comment-discussion shrink-0 text-[12px]!" />
								<span className="truncate">{entry.group.title}</span>
							</span>
							{entry.rows.map((row) => threadTab(row, true))}
						</div>
					),
				)}
				{overflow > 0 && (
					<button
						aria-label={`${overflow} more thread${overflow === 1 ? "" : "s"}`}
						className="flex h-5.5 shrink-0 cursor-pointer items-center rounded-xs border-0 bg-transparent px-1.5 text-[11px] text-description hover:bg-list-hover hover:text-foreground focus-visible:outline focus-visible:outline-1 focus-visible:outline-(--vscode-focusBorder)"
						data-testid="one-view-strip-overflow"
						onClick={onToggleList}
						type="button">
						+{overflow}
					</button>
				)}
			</div>
			<HeaderIconButton
				data-testid="one-view-strip-search"
				icon="search"
				label="Search threads, tasks, notes"
				onClick={onSearch}
			/>
		</div>
	)
}
