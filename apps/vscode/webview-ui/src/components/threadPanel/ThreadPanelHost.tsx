import type { ClineMessage } from "@shared/ExtensionMessage"
import type { HistoryItem } from "@shared/HistoryItem"
import {
	createContext,
	type KeyboardEvent,
	type ReactNode,
	useContext,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react"
import type { LineageRow } from "@/components/chat/chat-view/utils/threadUtils"
import { useComposerContextUsage } from "@/components/chat/composer/ContextUsageIndicator"
import { contextUsagePercent } from "@/components/chat/composer/contextUsage"
import { useSubagentLineage } from "@/components/chat/task-header/SubagentPanel"
import { type Dock, readDock } from "@/components/oneView/layoutPrefs"
import { SideThreadColumn } from "@/components/sideThreads/SideThreadColumn"
import { setPanelRoom, useSideThreadSlots } from "@/components/sideThreads/sideThreadStore"
import { useWorktree } from "@/components/worktrees/useWorktree"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { cn } from "@/lib/utils"
import { PanelSectionsMenu, ROW_ICON_BUTTON_CLASS, StatusDot, ThreadPanelSections, type ThreadUsage } from "./ThreadPanel"
import { buildAgentRows, changedFiles } from "./threadPanelModel"
import { PANEL_COLUMN_MIN_WIDTH, PANEL_COLUMN_WIDTH, useThreadPanelPrefs } from "./threadPanelPrefs"

export interface ThreadPanelData {
	item: HistoryItem
	messages: readonly ClineMessage[]
	usage: ThreadUsage
	onNewSideThread?: () => void
	onOpenSubagentPreview?: (row: LineageRow) => void
}

interface PlacementState {
	/** There's room for the column beside the chat. */
	column: boolean
	data?: ThreadPanelData
}

const PlacementContext = createContext<PlacementState>({ column: false })

function useListDock(): Dock {
	const [dock, setDock] = useState<Dock>(readDock)
	useEffect(() => {
		const update = () => setDock(readDock())
		window.addEventListener("cline:dock-changed", update)
		return () => window.removeEventListener("cline:dock-changed", update)
	}, [])
	return dock
}

const PanelHeader = ({ onClose, closeHint }: { onClose: () => void; closeHint: string }) => (
	<div className="flex h-10 shrink-0 items-center gap-1.5 border-0 border-b border-solid border-border-panel pr-1.5 pl-3 text-[12px] font-semibold">
		<span aria-hidden className="codicon codicon-layout-sidebar-right text-[14px] font-normal text-description" />
		<span className="flex-1">This thread</span>
		<PanelSectionsMenu />
		<button
			aria-label="Hide the thread panel"
			className={ROW_ICON_BUTTON_CLASS}
			onClick={onClose}
			title={closeHint}
			type="button">
			<span aria-hidden className="codicon codicon-close text-[13px]" />
		</button>
	</div>
)

/**
 * The chat plus "This thread" beside it when there's room (wide): a column on the side the
 * thread list isn't on, which also hosts a side thread opened beside Main. Narrow, the panel
 * is the summary line under the header ({@link ThreadPanelLine}), opened in place.
 */
export const ThreadPanelHost = ({
	data,
	hidden,
	children,
}: {
	/** The thread on screen; undefined on home, a task page or a subagent. */
	data?: ThreadPanelData
	hidden?: boolean
	children: ReactNode
}) => {
	const ref = useRef<HTMLDivElement>(null)
	const [width, setWidth] = useState(0)
	const prefs = useThreadPanelPrefs()
	const { beside } = useSideThreadSlots()
	const dock = useListDock()

	useLayoutEffect(() => {
		const element = ref.current
		if (!element) return
		if (element.clientWidth > 0) setWidth(element.clientWidth)
		const observer = new ResizeObserver((entries) => {
			const entry = entries[0]
			if (entry && entry.contentRect.width > 0) setWidth(entry.contentRect.width)
		})
		observer.observe(element)
		return () => observer.disconnect()
	}, [])

	const room = width >= PANEL_COLUMN_MIN_WIDTH
	useEffect(() => {
		setPanelRoom(room && !!data)
	}, [room, data])

	const sideId = data ? beside[data.item.id] : undefined
	// A side thread opened beside Main always gets the column, even if the panel was hidden.
	const showColumn = room && !!data && (prefs.columnOpen || !!sideId)
	const placement = useMemo<PlacementState>(() => ({ column: room && !!data, data }), [room, data])

	const column = showColumn && data && (
		<aside
			aria-label={sideId ? "Side thread" : "This thread"}
			className={cn(
				"flex min-h-0 shrink-0 flex-col border-0 border-solid border-border-panel bg-sidebar-background",
				dock === "right" ? "border-r" : "border-l",
			)}
			data-testid="thread-panel-column"
			key="panel"
			style={{ width: PANEL_COLUMN_WIDTH }}>
			{sideId ? (
				<SideThreadColumn mainId={data.item.id} sideId={sideId} />
			) : (
				<>
					<PanelHeader
						closeHint="Hide the panel (the line under the header brings it back)"
						onClose={() => prefs.setColumnOpen(false)}
					/>
					<div className="min-h-0 flex-1 overflow-y-auto">
						<ThreadPanelSections {...data} />
					</div>
				</>
			)}
		</aside>
	)

	const main = (
		<div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" key="chat">
			{children}
		</div>
	)

	return (
		<div
			className={cn("flex min-h-0 min-w-0 flex-1 flex-row overflow-hidden", hidden && "hidden")}
			data-testid="thread-panel-host"
			ref={ref}>
			<PlacementContext.Provider value={placement}>
				{column && dock === "right" ? [column, main] : [main, column]}
			</PlacementContext.Provider>
		</div>
	)
}

/**
 * Under the thread header: a one-line summary of this thread (branch, changes, live agents,
 * context). Narrow, it opens the panel in place (pushing the chat down, not covering it);
 * wide with the column hidden, it brings the column back.
 */
export const ThreadPanelLine = ({ data: fallback }: { data?: ThreadPanelData }) => {
	const placement = useContext(PlacementContext)
	const column = placement.column
	// The classic layout has no host: the line works on its own there, always in place.
	const data = placement.data ?? fallback
	const prefs = useThreadPanelPrefs()
	const { beside } = useSideThreadSlots()
	if (!data) return null
	if (column && (prefs.columnOpen || beside[data.item.id])) return null
	const open = !column && prefs.lineOpen
	const toggle = () => (column ? prefs.setColumnOpen(true) : prefs.setLineOpen(!prefs.lineOpen))
	return (
		<div className="mx-4 mb-1 flex shrink-0 flex-col" data-testid="thread-panel-line">
			<SummaryLine data={data} onToggle={toggle} open={open} wide={column} />
			{open && (
				<section
					aria-label="This thread"
					className="flex max-h-[min(60vh,440px)] min-h-0 flex-col overflow-hidden rounded-b-sm border border-t-0 border-menu-border bg-menu text-menu-foreground shadow-[0_4px_16px_var(--vscode-widget-shadow)]"
					data-testid="thread-panel-drawer"
					onKeyDown={(event: KeyboardEvent) => {
						if (event.key === "Escape") {
							event.preventDefault()
							prefs.setLineOpen(false)
						}
					}}>
					<div className="flex h-8 shrink-0 items-center gap-1.5 border-0 border-b border-solid border-menu-foreground/10 pr-1.5 pl-3 text-[12px] font-semibold">
						<span className="flex-1">This thread</span>
						<PanelSectionsMenu />
						<kbd className="text-[10px] font-normal text-description">Esc</kbd>
					</div>
					<div className="min-h-0 flex-1 overflow-y-auto">
						<ThreadPanelSections {...data} />
					</div>
				</section>
			)}
		</div>
	)
}

const SummaryLine = ({
	data,
	open,
	wide,
	onToggle,
}: {
	data: ThreadPanelData
	open: boolean
	wide: boolean
	onToggle: () => void
}) => {
	const { currentBranch, taskHistory, sessionStatuses, mode } = useExtensionState()
	const worktree = useWorktree(data.item.id)
	const lineage = useSubagentLineage()
	const { contextWindow } = useComposerContextUsage(mode, data.usage.totalCost)
	const branch = worktree.state?.mapping?.branch
	const files = useMemo(() => changedFiles(data.messages), [data.messages])
	const agents = useMemo(
		() => buildAgentRows(data.item.id, taskHistory ?? [], sessionStatuses, lineage?.children ?? []),
		[data.item.id, taskHistory, sessionStatuses, lineage?.children],
	)
	const running = agents.filter((row) => !row.tucked && (row.status === "running" || row.status === "subagents")).length
	const waiting = agents.filter((row) => !row.tucked && row.status === "waiting").length
	const percent = contextUsagePercent(data.usage.lastApiReqTotalTokens, contextWindow)
	return (
		<button
			aria-expanded={wide ? undefined : open}
			className={cn(
				"flex h-6 min-w-0 cursor-pointer items-center gap-1.5 overflow-hidden whitespace-nowrap rounded-xs border border-editor-group-border bg-transparent pr-1.5 pl-2 text-left text-[11px] text-description hover:bg-list-hover hover:text-foreground focus-visible:outline focus-visible:outline-1 focus-visible:outline-(--vscode-focusBorder)",
				open && "rounded-b-none bg-list-hover text-foreground",
			)}
			data-testid="thread-panel-summary"
			onClick={onToggle}
			title={wide ? "Show this thread's panel" : "This thread: branch, changes, agents, notes, context"}
			type="button">
			<span
				aria-hidden
				className={cn("codicon codicon-git-branch shrink-0 text-[12px]", branch && "text-(--vscode-charts-green)")}
			/>
			<span className="min-w-0 truncate font-mono">{branch ?? (currentBranch || "workspace")}</span>
			{files.length > 0 && (
				<>
					<span className="opacity-50">·</span>
					<span className="shrink-0">{files.length === 1 ? "1 file" : `${files.length} files`}</span>
				</>
			)}
			{(running > 0 || waiting > 0) && (
				<>
					<span className="opacity-50">·</span>
					{running > 0 && (
						<span className="flex shrink-0 items-center gap-1">
							<StatusDot label={`${running} running`} status="running" />
							{running}
						</span>
					)}
					{waiting > 0 && (
						<span className="flex shrink-0 items-center gap-1 text-warning">
							<StatusDot label={`${waiting} need you`} status="waiting" />
							{waiting}
						</span>
					)}
				</>
			)}
			{percent !== undefined && (
				<>
					<span className="opacity-50">·</span>
					<span className="shrink-0 font-mono">{Math.round(percent)}%</span>
				</>
			)}
			<span className="flex-1" />
			<span
				aria-hidden
				className={cn(
					"codicon shrink-0 text-[12px] transition-transform duration-150 motion-reduce:transition-none",
					wide ? "codicon-layout-sidebar-right" : "codicon-chevron-down",
					open && "rotate-180",
				)}
			/>
		</button>
	)
}
