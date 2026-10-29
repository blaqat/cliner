import { type ReactNode, useLayoutEffect, useRef, useState } from "react"
import { HeaderIconButton } from "@/components/chat/task-header/HeaderIconButton"
import type { InboxRow } from "@/components/inbox/inboxUtils"
import { cn } from "@/lib/utils"
import { RowStatusIcon } from "./ThreadListRows"
import { visibleStripChips } from "./threadListModel"

/** Room one chip takes in the strip, and what the "+N" chip keeps free. */
export const STRIP_CHIP_SLOT = 104
const OVERFLOW_ROOM = 34

interface ThreadStripBarProps {
	rows: readonly InboxRow[]
	/** The open thread's top-level row id. */
	currentRowId?: string
	onOpenThread: (threadId: string) => void
	/** The ☰ dropdown (the full list with search) is open. */
	listOpen: boolean
	onToggleList: () => void
	/** Opens the dropdown with its search field focused. */
	onSearch: () => void
	onNewChat: () => void
	/** The dock grip (wide webviews only). */
	grip?: ReactNode
}

/**
 * The narrow layout's list: ☰ (the full list as a dropdown), one row of thread chips (status and a
 * short title, the open one highlighted, the rest behind "+N"), then search and ✎ New.
 */
export const ThreadStripBar = ({
	rows,
	currentRowId,
	onOpenThread,
	listOpen,
	onToggleList,
	onSearch,
	onNewChat,
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
	const fitAll = Math.floor(room / STRIP_CHIP_SLOT)
	const fit = rows.length <= fitAll ? rows.length : Math.floor((room - OVERFLOW_ROOM) / STRIP_CHIP_SLOT)
	const shown = rows.length === 0 ? [] : visibleStripChips(rows, fit, currentRowId)
	const overflow = rows.length - shown.length

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
				{shown.length === 0 && <span className="truncate px-1 text-[11px] text-description">No active threads</span>}
				{shown.map((row) => {
					const title = row.item.title?.trim() || row.item.task
					const current = row.item.id === currentRowId
					return (
						<button
							aria-current={current ? "true" : undefined}
							className={cn(
								"flex h-5.5 min-w-0 max-w-30 shrink cursor-pointer items-center gap-1 rounded-xs border px-1.5 text-[11px] focus-visible:outline focus-visible:outline-1 focus-visible:outline-(--vscode-focusBorder)",
								current
									? "border-(--vscode-focusBorder) bg-selection/40 text-foreground"
									: "border-transparent bg-transparent text-description hover:bg-list-hover hover:text-foreground",
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
				})}
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
			<HeaderIconButton data-testid="one-view-strip-new" icon="edit" label="New chat" onClick={onNewChat} />
		</div>
	)
}
