import * as PopoverPrimitive from "@radix-ui/react-popover"
import type { ClineMessage } from "@shared/ExtensionMessage"
import type { HistoryItem } from "@shared/HistoryItem"
import { type ReactNode, type RefObject, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import type { LineageRow } from "@/components/chat/chat-view/utils/threadUtils"
import { HeaderIconButton } from "@/components/chat/task-header/HeaderIconButton"
import { type Dock, readDock } from "@/components/oneView/layoutPrefs"
import { SideThreadColumn } from "@/components/sideThreads/SideThreadColumn"
import { setPanelRoom, useSideThreadSlots } from "@/components/sideThreads/sideThreadStore"
import { cn } from "@/lib/utils"
import { PanelSectionsMenu, ROW_ICON_BUTTON_CLASS, ThreadPanelSections, type ThreadUsage } from "./ThreadPanel"
import {
	PANEL_MIN_ROOM,
	PANEL_WIDTH,
	SIDE_COLUMN_MIN_ROOM,
	SIDE_COLUMN_WIDTH,
	setThreadPanelUi,
	useThreadPanelPrefs,
	useThreadPanelUi,
} from "./threadPanelPrefs"

export interface ThreadPanelData {
	item: HistoryItem
	messages: readonly ClineMessage[]
	usage: ThreadUsage
	onNewSideThread?: () => void
	onOpenSubagentPreview?: (row: LineageRow) => void
}

const PANEL_ID = "thread-panel"

function useListDock(): Dock {
	const [dock, setDock] = useState<Dock>(readDock)
	useEffect(() => {
		const update = () => setDock(readDock())
		window.addEventListener("cline:dock-changed", update)
		return () => window.removeEventListener("cline:dock-changed", update)
	}, [])
	return dock
}

/** The element's width, kept current; 0 until it's laid out (or while hidden). */
function useWidth(ref: RefObject<HTMLElement | null>): number {
	const [width, setWidth] = useState(0)
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
	}, [ref])
	return width
}

/**
 * The chat plus a side thread opened beside Main, as a column on the side the thread list
 * isn't on, when Main keeps its room. "This thread" itself lives in {@link ThreadPanelFrame}.
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
	const width = useWidth(ref)
	const { beside } = useSideThreadSlots()
	const dock = useListDock()

	const room = width >= SIDE_COLUMN_MIN_ROOM
	useEffect(() => {
		setPanelRoom(room && !!data)
	}, [room, data])

	const sideId = data ? beside[data.item.id] : undefined
	const column = room && data && sideId && (
		<aside
			aria-label="Side thread"
			className={cn(
				"flex min-h-0 shrink-0 flex-col border-0 border-solid border-border-panel bg-sidebar-background",
				dock === "right" ? "border-r" : "border-l",
			)}
			data-testid="side-thread-beside"
			key="side"
			style={{ width: SIDE_COLUMN_WIDTH }}>
			<SideThreadColumn mainId={data.item.id} sideId={sideId} />
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
			{column && dock === "right" ? [column, main] : [main, column]}
		</div>
	)
}

const PanelHeader = ({ onClose, closeHint }: { onClose: () => void; closeHint: string }) => (
	<div className="flex h-8 shrink-0 items-center gap-1 border-0 border-b border-solid border-border-panel pr-1 pl-3 text-[12px] font-semibold">
		<span className="min-w-0 flex-1 truncate">This thread</span>
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
 * The messages plus "This thread", which the header toggle ({@link ThreadPanelToggle}) shows
 * or hides. With room, it's a card beside the messages, as tall as its sections need. Without
 * room, the toggle opens it over the messages, hanging from the toggle, until you click
 * elsewhere or press Esc. Either way it has one scroll region: its sections.
 */
export const ThreadPanelFrame = ({ data, children }: { data?: ThreadPanelData; children: ReactNode }) => {
	const ref = useRef<HTMLDivElement>(null)
	const width = useWidth(ref)
	const prefs = useThreadPanelPrefs()
	const { overlayOpen, toggle } = useThreadPanelUi()
	const room = width >= PANEL_MIN_ROOM
	const available = !!data
	const threadId = data?.item.id
	// Clicking elsewhere closes the overlay; focus then stays where the user clicked.
	const interactedOutside = useRef(false)

	useEffect(() => {
		setThreadPanelUi({ available, room })
	}, [available, room])
	// A new thread, more room, or no panel at all: the overlay doesn't carry over.
	// biome-ignore lint/correctness/useExhaustiveDependencies: closes when any of these change
	useEffect(() => {
		setThreadPanelUi({ overlayOpen: false })
	}, [room, available, threadId])
	useEffect(() => () => setThreadPanelUi({ available: false, overlayOpen: false }), [])

	const anchor = useMemo(() => ({ current: toggle }), [toggle])
	const setOverlayOpen = useCallback((open: boolean) => setThreadPanelUi({ overlayOpen: open }), [])

	return (
		<div className="flex min-h-0 min-w-0 flex-1 flex-row" data-testid="thread-panel-frame" ref={ref}>
			<div className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
			{data && room && prefs.open && (
				<aside
					aria-label="This thread"
					className="mt-1 mr-3 mb-2 flex max-h-[calc(100%-12px)] min-h-0 shrink-0 flex-col self-start overflow-hidden rounded-sm border border-solid border-border-panel bg-sidebar-background"
					data-testid="thread-panel-column"
					id={PANEL_ID}
					style={{ width: PANEL_WIDTH }}>
					<PanelHeader
						closeHint="Hide this panel (the panel button in the header brings it back)"
						onClose={() => prefs.setOpen(false)}
					/>
					<div className="min-h-0 flex-1 overflow-y-auto">
						<ThreadPanelSections {...data} />
					</div>
				</aside>
			)}
			{data && !room && toggle && (
				<PopoverPrimitive.Root onOpenChange={setOverlayOpen} open={overlayOpen}>
					<PopoverPrimitive.Anchor virtualRef={anchor as RefObject<HTMLElement>} />
					<PopoverPrimitive.Portal>
						<PopoverPrimitive.Content
							align="end"
							aria-label="This thread"
							className="z-50 flex max-h-[min(70vh,var(--radix-popover-content-available-height))] w-[min(300px,calc(100vw-16px))] flex-col overflow-hidden rounded-sm border border-solid border-menu-foreground/10 bg-menu text-menu-foreground shadow-[0_4px_16px_var(--vscode-widget-shadow)] outline-hidden"
							collisionPadding={8}
							data-testid="thread-panel-overlay"
							id={PANEL_ID}
							onCloseAutoFocus={(event) => {
								event.preventDefault()
								if (!interactedOutside.current) toggle.focus()
								interactedOutside.current = false
							}}
							onInteractOutside={(event) => {
								// The toggle closes it itself; letting this through would close then reopen it.
								if (toggle.contains(event.target as Node)) event.preventDefault()
								else interactedOutside.current = true
							}}
							side="bottom"
							sideOffset={4}>
							<PanelHeader closeHint="Close (Esc)" onClose={() => setOverlayOpen(false)} />
							<div className="min-h-0 flex-1 overflow-y-auto">
								<ThreadPanelSections {...data} />
							</div>
						</PopoverPrimitive.Content>
					</PopoverPrimitive.Portal>
				</PopoverPrimitive.Root>
			)}
		</div>
	)
}

/**
 * The thread header's panel button: shows or hides "This thread" beside the messages
 * (remembered), or, when there's no room, opens it over them until you click elsewhere.
 */
export const ThreadPanelToggle = () => {
	const { available, room, overlayOpen } = useThreadPanelUi()
	const prefs = useThreadPanelPrefs()
	const register = useCallback((element: HTMLButtonElement | null) => setThreadPanelUi({ toggle: element }), [])
	if (!available) return null
	const shown = room ? prefs.open : overlayOpen
	return (
		<HeaderIconButton
			aria-controls={shown ? PANEL_ID : undefined}
			aria-expanded={shown}
			className={cn(shown && "bg-toolbar-hover text-foreground")}
			data-testid="thread-panel-toggle"
			icon={shown ? "layout-sidebar-right" : "layout-sidebar-right-off"}
			label={shown ? "Hide this thread's panel" : "Show this thread's panel"}
			onClick={() => (room ? prefs.setOpen(!prefs.open) : setThreadPanelUi({ overlayOpen: !overlayOpen }))}
			ref={register}
			tooltip={
				shown ? "Hide this thread's panel" : "This thread: branch and changes, side threads and agents, notes, context"
			}
		/>
	)
}
