import * as PopoverPrimitive from "@radix-ui/react-popover"
import {
	type CSSProperties,
	type KeyboardEvent,
	type ReactNode,
	type PointerEvent as ReactPointerEvent,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react"
import { HEADER_ICON_BUTTON_CLASS, HeaderIconButton } from "@/components/chat/task-header/HeaderIconButton"
import { MENU_ICON_CLASS, MENU_ITEM_CLASS, MENU_SEPARATOR_CLASS } from "@/components/common/menuStyles"
import { buildInbox } from "@/components/inbox/inboxUtils"
import { Popover, PopoverContent } from "@/components/ui/popover"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { cn } from "@/lib/utils"
import { useShortcut } from "@/utils/hooks"
import {
	clampListWidth,
	type Dock,
	dockAt,
	LIST_MAX_WIDTH,
	LIST_MIN_WIDTH,
	LIST_RESIZE_STEP,
	readDock,
	readListHidden,
	readListWidth,
	resolvePlacement,
	WIDE_MIN_WIDTH,
	writeDock,
	writeListHidden,
	writeListWidth,
} from "./layoutPrefs"
import { OneViewContext, type OneViewState } from "./OneViewContext"
import { ThreadList } from "./ThreadList"
import { ThreadStripBar } from "./ThreadStripBar"
import { stripThreads, topThreadId } from "./threadListModel"

/** Pointer travel before a press on the grip becomes a drag (below it, it's a click: the dock menu). */
const DRAG_THRESHOLD = 5

const DOCK_LABEL: Record<Dock, string> = { left: "Dock left", right: "Dock right", top: "Dock on top" }
const DOCK_ICON: Record<Dock, string> = { left: "layout-sidebar-left", right: "layout-sidebar-right", top: "layout-panel" }

interface OneViewLayoutProps {
	/** A full-page view (Settings, History, …) covers everything. */
	hidden: boolean
	currentThreadId?: string
	currentTaskGroupId?: string
	onOpenThread: (threadId: string) => void
	onOpenTaskGroup: (taskGroupId: string) => void
	onNewChat: () => void
	/** The main region: new chat, a thread, or a task page. */
	children: ReactNode
	/** Clock override for tests and stories. */
	now?: number
}

/**
 * One view: the thread list beside whatever is open. Wide webviews get a side list (left by
 * default, resizable, hideable); narrow ones get a strip of thread chips whose ☰ drops down the
 * full list. Dragging the list's grip docks it left, right or on top; the choice is remembered.
 */
export const OneViewLayout = ({
	hidden,
	currentThreadId,
	currentTaskGroupId,
	onOpenThread,
	onOpenTaskGroup,
	onNewChat,
	children,
	now,
}: OneViewLayoutProps) => {
	const { taskHistory, sessionStatuses, subagentCounts, taskGroups } = useExtensionState()
	const shellRef = useRef<HTMLDivElement>(null)
	const stripRef = useRef<HTMLDivElement>(null)
	const [width, setWidth] = useState(() => (typeof window === "undefined" ? 1024 : window.innerWidth))
	const [dock, setDock] = useState<Dock>(readDock)
	const [listWidth, setListWidth] = useState(readListWidth)
	const [listHidden, setListHidden] = useState(readListHidden)
	const [dragZone, setDragZone] = useState<Dock | null>(null)
	const [dockMenuOpen, setDockMenuOpen] = useState(false)
	const [dropdownOpen, setDropdownOpen] = useState(false)
	const [focusSearchSignal, setFocusSearchSignal] = useState(0)
	const suppressClickRef = useRef(false)

	useLayoutEffect(() => {
		const element = shellRef.current
		if (!element) return
		if (element.clientWidth > 0) setWidth(element.clientWidth)
		const observer = new ResizeObserver((entries) => {
			const entry = entries[0]
			if (entry && entry.contentRect.width > 0) setWidth(entry.contentRect.width)
		})
		observer.observe(element)
		return () => observer.disconnect()
	}, [])

	const placement = resolvePlacement(width, dock)
	// Narrow webviews always get the strip, so docking is only offered when wide.
	const wide = width >= WIDE_MIN_WIDTH
	const side = placement !== "top"
	const sideWidth = clampListWidth(listWidth, width)

	const history = useMemo(() => taskHistory ?? [], [taskHistory])
	const currentRowId = useMemo(
		() => (currentThreadId ? topThreadId(currentThreadId, new Map(history.map((item) => [item.id, item]))) : undefined),
		[currentThreadId, history],
	)
	const stripRows = useMemo(() => {
		if (side) return []
		const inbox = buildInbox(history, sessionStatuses, subagentCounts, {
			activeLimit: Number.MAX_SAFE_INTEGER,
			settledLimit: Number.MAX_SAFE_INTEGER,
			stashedLimit: Number.MAX_SAFE_INTEGER,
			taskGroups,
		})
		return stripThreads(inbox, currentThreadId, history)
	}, [side, history, sessionStatuses, subagentCounts, taskGroups, currentThreadId])

	const changeDock = useCallback((next: Dock) => {
		setDock(next)
		writeDock(next)
		setDropdownOpen(false)
	}, [])

	const toggleList = useCallback(
		() =>
			setListHidden((current) => {
				writeListHidden(!current)
				return !current
			}),
		[],
	)

	// ⌘K / Ctrl+K: the list's search, showing the list (or its dropdown) first.
	useShortcut(
		"Meta+k",
		() => {
			if (hidden) return
			if (side) {
				if (listHidden) {
					setListHidden(false)
					writeListHidden(false)
				}
			} else {
				setDropdownOpen(true)
			}
			setFocusSearchSignal((signal) => signal + 1)
		},
		{ disableTextInputs: false },
	)

	// The dropdown closes on a click anywhere outside the strip and its panel.
	useEffect(() => {
		if (!dropdownOpen) return
		const onPointerDown = (event: PointerEvent) => {
			if (!stripRef.current?.contains(event.target as Node)) setDropdownOpen(false)
		}
		document.addEventListener("pointerdown", onPointerDown, true)
		return () => document.removeEventListener("pointerdown", onPointerDown, true)
	}, [dropdownOpen])

	// The dropdown only exists for the strip.
	useEffect(() => {
		if (side) setDropdownOpen(false)
	}, [side])

	const startDockDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
		if (event.button > 0) return
		const shell = shellRef.current
		if (!shell) return
		const startX = event.clientX
		const startY = event.clientY
		let dragging = false
		const zoneFor = (x: number, y: number) => dockAt(x, y, shell.getBoundingClientRect())
		const onMove = (move: PointerEvent) => {
			if (!dragging && Math.hypot(move.clientX - startX, move.clientY - startY) < DRAG_THRESHOLD) return
			dragging = true
			setDragZone(zoneFor(move.clientX, move.clientY))
		}
		const finish = (up: PointerEvent | null) => {
			window.removeEventListener("pointermove", onMove)
			window.removeEventListener("pointerup", onUp)
			window.removeEventListener("keydown", onKey, true)
			setDragZone(null)
			if (!dragging) return
			// The click that follows the drag's pointerup must not open the dock menu.
			suppressClickRef.current = true
			if (up) changeDock(zoneFor(up.clientX, up.clientY))
		}
		const onUp = (up: PointerEvent) => finish(up)
		const onKey = (key: globalThis.KeyboardEvent) => {
			if (key.key !== "Escape") return
			key.preventDefault()
			key.stopPropagation()
			finish(null)
		}
		window.addEventListener("pointermove", onMove)
		window.addEventListener("pointerup", onUp)
		window.addEventListener("keydown", onKey, true)
	}

	const grip = wide ? (
		<Popover onOpenChange={setDockMenuOpen} open={dockMenuOpen}>
			<PopoverPrimitive.Anchor asChild>
				<button
					aria-haspopup="menu"
					aria-label="Move the list"
					className={cn(
						HEADER_ICON_BUTTON_CLASS,
						"cursor-grab active:cursor-grabbing",
						dockMenuOpen && "bg-toolbar-hover text-foreground",
					)}
					data-testid="one-view-grip"
					onClick={() => {
						if (suppressClickRef.current) {
							suppressClickRef.current = false
							return
						}
						setDockMenuOpen((open) => !open)
					}}
					onPointerDown={startDockDrag}
					title="Drag to dock the list left, right or on top (or click)"
					type="button">
					<span aria-hidden className="codicon codicon-gripper text-[14px]" />
				</button>
			</PopoverPrimitive.Anchor>
			<PopoverContent align="start" className="w-44 p-1 motion-reduce:animate-none" side="bottom">
				<div className="flex flex-col" data-testid="one-view-dock-menu" role="menu">
					{(["left", "right", "top"] as const).map((option) => (
						<button
							aria-checked={dock === option}
							className={MENU_ITEM_CLASS}
							key={option}
							onClick={() => {
								setDockMenuOpen(false)
								changeDock(option)
							}}
							role="menuitemradio"
							type="button">
							<span aria-hidden className={cn(MENU_ICON_CLASS, `codicon-${DOCK_ICON[option]}`)} />
							<span className="flex-1">{DOCK_LABEL[option]}</span>
							{dock === option && <span aria-hidden className="codicon codicon-check text-[12px]" />}
						</button>
					))}
					{side && (
						<>
							<hr className={MENU_SEPARATOR_CLASS} />
							<button
								className={MENU_ITEM_CLASS}
								onClick={() => {
									setDockMenuOpen(false)
									toggleList()
								}}
								role="menuitem"
								type="button">
								<span aria-hidden className={cn(MENU_ICON_CLASS, `codicon-${DOCK_ICON[dock]}-off`)} />
								Hide the list
							</button>
						</>
					)}
				</div>
			</PopoverContent>
		</Popover>
	) : undefined

	const listToggle = side ? (
		<HeaderIconButton
			aria-pressed={!listHidden}
			data-testid="one-view-list-toggle"
			icon={listHidden ? `${DOCK_ICON[dock]}-off` : DOCK_ICON[dock]}
			label={listHidden ? "Show the list" : "Hide the list"}
			onClick={toggleList}
		/>
	) : null

	const context = useMemo<OneViewState>(() => ({ enabled: true, listToggle }), [listToggle])

	const resizeBy = (delta: number) => {
		const next = clampListWidth(sideWidth + delta, width)
		setListWidth(next)
		writeListWidth(next)
	}

	const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
		if (event.button > 0) return
		event.preventDefault()
		const startX = event.clientX
		const startWidth = sideWidth
		const containerWidth = width
		let latest = startWidth
		const onMove = (move: PointerEvent) => {
			const delta = move.clientX - startX
			latest = clampListWidth(dock === "right" ? startWidth - delta : startWidth + delta, containerWidth)
			setListWidth(latest)
		}
		const onUp = () => {
			window.removeEventListener("pointermove", onMove)
			window.removeEventListener("pointerup", onUp)
			writeListWidth(latest)
		}
		window.addEventListener("pointermove", onMove)
		window.addEventListener("pointerup", onUp)
	}

	const onResizeKey = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
		event.preventDefault()
		const grow = (event.key === "ArrowRight") === (dock !== "right")
		resizeBy(grow ? LIST_RESIZE_STEP : -LIST_RESIZE_STEP)
	}

	const openThread = (id: string) => {
		setDropdownOpen(false)
		onOpenThread(id)
	}
	const openTaskGroup = (id: string) => {
		setDropdownOpen(false)
		onOpenTaskGroup(id)
	}
	const newChat = () => {
		setDropdownOpen(false)
		onNewChat()
	}

	const main = (
		<div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" data-testid="one-view-main" key="main">
			{children}
		</div>
	)

	const sideList = (
		<aside
			aria-label="Threads"
			className={cn(
				"relative flex min-h-0 shrink-0 flex-col border-editor-group-border bg-background",
				dock === "right" ? "border-l" : "border-r",
			)}
			data-dock={dock}
			data-testid="one-view-side"
			key="list"
			style={{ width: sideWidth }}>
			<ThreadList
				currentTaskGroupId={currentTaskGroupId}
				currentThreadId={currentThreadId}
				focusSearchSignal={focusSearchSignal}
				grip={grip}
				now={now}
				onNewChat={newChat}
				onOpenTaskGroup={openTaskGroup}
				onOpenThread={openThread}
			/>
			{/* biome-ignore lint/a11y/useSemanticElements: a focusable splitter has no semantic element */}
			<div
				aria-label="Resize the list"
				aria-orientation="vertical"
				aria-valuemax={LIST_MAX_WIDTH}
				aria-valuemin={LIST_MIN_WIDTH}
				aria-valuenow={sideWidth}
				className={cn(
					"absolute top-0 bottom-0 z-10 w-1 cursor-col-resize outline-none transition-colors duration-150 hover:bg-(--vscode-sash-hoverBorder) focus-visible:bg-(--vscode-focusBorder) motion-reduce:transition-none",
					dock === "right" ? "-left-0.5" : "-right-0.5",
				)}
				data-testid="one-view-resize"
				onKeyDown={onResizeKey}
				onPointerDown={startResize}
				role="separator"
				tabIndex={0}
			/>
		</aside>
	)

	const strip = (
		<div className="relative z-20 shrink-0" data-testid="one-view-strip-region" key="strip" ref={stripRef}>
			<ThreadStripBar
				currentRowId={currentRowId}
				grip={grip}
				listOpen={dropdownOpen}
				onNewChat={newChat}
				onOpenThread={openThread}
				onSearch={() => {
					setDropdownOpen(true)
					setFocusSearchSignal((signal) => signal + 1)
				}}
				onToggleList={() => setDropdownOpen((open) => !open)}
				rows={stripRows}
			/>
			{dropdownOpen && (
				<div
					aria-label="Threads"
					className="absolute inset-x-0 top-full flex max-h-[70vh] min-h-0 flex-col border-b border-editor-group-border bg-background shadow-md"
					data-testid="one-view-dropdown"
					role="dialog">
					<ThreadList
						currentTaskGroupId={currentTaskGroupId}
						currentThreadId={currentThreadId}
						focusSearchSignal={focusSearchSignal}
						now={now}
						onEscape={() => setDropdownOpen(false)}
						onNewChat={newChat}
						onOpenTaskGroup={openTaskGroup}
						onOpenThread={openThread}
					/>
				</div>
			)}
		</div>
	)

	const regions = !side ? [strip, main] : listHidden ? [main] : dock === "right" ? [main, sideList] : [sideList, main]

	return (
		<div
			className={cn("relative flex h-full min-h-0 w-full flex-1 overflow-hidden", side ? "flex-row" : "flex-col")}
			data-placement={placement}
			data-testid="one-view"
			ref={shellRef}
			style={hidden ? { display: "none" } : undefined}>
			<OneViewContext.Provider value={context}>{regions}</OneViewContext.Provider>
			{dragZone && <DockOverlay zone={dragZone} />}
		</div>
	)
}

/** While the grip is dragged: where letting go docks the list. */
const DockOverlay = ({ zone }: { zone: Dock }) => {
	const area: Record<Dock, CSSProperties> = {
		top: { left: 0, right: 0, top: 0, height: "25%" },
		left: { left: 0, top: "25%", bottom: 0, width: "50%" },
		right: { right: 0, top: "25%", bottom: 0, width: "50%" },
	}
	return (
		<div
			aria-hidden
			className="pointer-events-none absolute inset-0 z-50"
			data-testid="one-view-dock-overlay"
			data-zone={zone}>
			<div
				className="absolute m-1 flex items-center justify-center rounded-xs border border-dashed border-(--vscode-focusBorder) bg-(--vscode-focusBorder)/15 text-[11px] text-foreground"
				style={area[zone]}>
				{DOCK_LABEL[zone]}
			</div>
		</div>
	)
}
