// The strip rail, hover preview, fisheye, wheel forwarding and turn navigation follow T3 Code's
// timeline minimap (apps/web/src/components/chat/MessagesTimeline.tsx, MIT, T3 Tools Inc.),
// rebuilt for the sidebar: it sits in its own column on the right and uses VS Code's colors.
import type { ClineMessage } from "@shared/ExtensionMessage"
import type React from "react"
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import {
	createMinimapTurnCache,
	getMinimapTurns,
	getVisibleMinimapTurns,
	MINIMAP_MIN_TURNS,
	type MinimapAttention,
	minimapIndexFromPointer,
	minimapTopPercent,
	minimapTurnKey,
	minimapTurnStatus,
} from "../../utils/minimapUtils"

// Below this chat width the column takes too much room from the messages.
const MIN_CHAT_WIDTH = 280
// From this width the strips always show at full strength; narrower, they're dimmer until
// hovered (T3 Code hides its minimap until hover when there's no side gutter for it).
const WIDE_CHAT_WIDTH = 560
// Rows hidden under the sticky user message header don't count as visible.
const TOP_INSET = 32
// Natural spacing between strips; a long thread packs them closer to fit the column.
const STRIP_SPACING = 8

const ATTENTION_FILL: Record<MinimapAttention, string> = {
	approval: "bg-warning",
	question: "bg-warning",
	error: "bg-error",
}

interface MiniMapProps {
	/** The unfiltered transcript (after the task prompt): turn boundaries come from here. */
	messages: ClineMessage[]
	/** The rendered (grouped) list: jump targets index into it. */
	rows: (ClineMessage | ClineMessage[])[]
	/** The task prompt: the first rendered row, shown as the first turn. */
	task?: ClineMessage
	/** Changes when the list remounts (task switch), so the scroll listener re-attaches. */
	listKey: number
	scrollContainerRef: React.RefObject<HTMLDivElement>
	/** Set while the user has scrolled away from the live end (auto-follow is off). */
	autoScrollDisabledRef: React.RefObject<boolean>
	/** The backend reports a streaming turn: the last strip shows it's in progress. */
	turnActive: boolean
	onJump: (index: number) => void
}

/** The visible rows of the list: the first and last [data-index] row overlapping the viewport. */
function visibleRows(scroller: HTMLElement): { first: number; last: number } | undefined {
	const rect = scroller.getBoundingClientRect()
	const top = rect.top + TOP_INSET
	const rows = scroller.querySelectorAll<HTMLElement>("[data-index]")
	if (!rows.length) {
		return undefined
	}
	// Rows are in order: binary search the first one ending below the top edge.
	let lo = 0
	let hi = rows.length - 1
	while (lo < hi) {
		const mid = (lo + hi) >> 1
		if (rows[mid].getBoundingClientRect().bottom > top) {
			hi = mid
		} else {
			lo = mid + 1
		}
	}
	let last = lo
	while (last + 1 < rows.length && rows[last + 1].getBoundingClientRect().top < rect.bottom) {
		last++
	}
	return { first: Number(rows[lo].dataset.index), last: Number(rows[last].dataset.index) }
}

/**
 * The chat's minimap, after T3 Code's: a thin rail on the right with one strip per turn (your
 * prompt and the agent's reply). Strips for the turns on screen are bright; hovering magnifies
 * the strips near the pointer and previews that turn (prompt, reply, tools, what it's waiting
 * for); click jumps to the prompt. The wheel over the rail scrolls the chat, the chevrons step
 * between turns, and the arrow keys move through it from the keyboard. Turns waiting for an
 * approval or an answer, or that ended on an error, are colored. The rail never scrolls itself:
 * a long thread packs its strips closer.
 */
export const MiniMap = memo(
	({ messages, rows, task, listKey, scrollContainerRef, autoScrollDisabledRef, turnActive, onJump }: MiniMapProps) => {
		// Turns before the last one don't change while its reply streams in: each update picks up from
		// the last prompt instead of scanning the whole thread again.
		const turnCache = useRef<ReturnType<typeof createMinimapTurnCache>>()
		const turns = useMemo(() => {
			turnCache.current ??= createMinimapTurnCache()
			return getMinimapTurns(messages, rows, task, turnActive, turnCache.current)
		}, [messages, rows, task, turnActive])
		const [width, setWidth] = useState(WIDE_CHAT_WIDTH)
		const [visible, setVisible] = useState<{ first: number; last: number }>({
			first: Number.MAX_SAFE_INTEGER,
			last: Number.MAX_SAFE_INTEGER,
		})
		// The strip under the pointer or keyboard focus, which the preview shows.
		const [active, setActive] = useState<number | null>(null)
		const columnRef = useRef<HTMLDivElement | null>(null)
		const scrollerRef = useRef<HTMLElement | null>(null)

		useEffect(() => {
			const container = scrollContainerRef.current
			if (!container || typeof ResizeObserver === "undefined") {
				return
			}
			const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
			observer.observe(container)
			return () => observer.disconnect()
		}, [scrollContainerRef])

		// Track which rows are on screen. While the list follows new output the reader is at the
		// live end: the last turn is in view however the rows above shift as it grows.
		useEffect(() => {
			const scroller = scrollContainerRef.current?.querySelector<HTMLElement>('[data-virtuoso-scroller="true"]')
			scrollerRef.current = scroller ?? null
			if (!scroller) {
				return
			}
			let frame = 0
			const measure = () => {
				frame = 0
				const rows = visibleRows(scroller)
				if (!autoScrollDisabledRef.current) {
					setVisible((current) => {
						const first = rows?.first ?? Number.MAX_SAFE_INTEGER
						return current.first === first && current.last === Number.MAX_SAFE_INTEGER
							? current
							: { first, last: Number.MAX_SAFE_INTEGER }
					})
					return
				}
				if (rows) {
					setVisible((current) => (current.first === rows.first && current.last === rows.last ? current : rows))
				}
			}
			const onScroll = () => {
				if (!frame) {
					frame = requestAnimationFrame(measure)
				}
			}
			measure()
			scroller.addEventListener("scroll", onScroll, { passive: true })
			return () => {
				scroller.removeEventListener("scroll", onScroll)
				if (frame) {
					cancelAnimationFrame(frame)
				}
			}
		}, [scrollContainerRef, autoScrollDisabledRef, listKey, turns.length])

		const shown = width >= MIN_CHAT_WIDTH && turns.length >= MINIMAP_MIN_TURNS
		const { inView, current } = useMemo(() => {
			const seen = getVisibleMinimapTurns(turns, visible.first, visible.last)
			// At the live end the top row wobbles across a turn boundary as streaming rows are
			// re-measured; the reader is following the last turn, so it stays current.
			return visible.last === Number.MAX_SAFE_INTEGER && turns.length ? { ...seen, current: turns.length - 1 } : seen
		}, [turns, visible.first, visible.last])

		// The wheel over the rail scrolls the chat (the rail itself has nothing to scroll). The
		// chat's own wheel listener already reads it as a scroll gesture, so follow stops on "up".
		// biome-ignore lint/correctness/useExhaustiveDependencies: re-attaches when the column mounts or unmounts
		useEffect(() => {
			const column = columnRef.current
			if (!column) {
				return
			}
			const onWheel = (event: WheelEvent) => {
				const scroller = scrollerRef.current
				if (!scroller || event.ctrlKey || event.deltaY === 0) {
					return
				}
				event.preventDefault()
				const unit =
					event.deltaMode === WheelEvent.DOM_DELTA_LINE
						? 16
						: event.deltaMode === WheelEvent.DOM_DELTA_PAGE
							? scroller.clientHeight
							: 1
				scroller.scrollBy({ top: event.deltaY * unit })
			}
			column.addEventListener("wheel", onWheel, { passive: false })
			return () => column.removeEventListener("wheel", onWheel)
		}, [shown])

		const jump = useCallback(
			(index: number) => {
				const turn = turns[index]
				if (turn) {
					onJump(turn.index)
				}
			},
			[turns, onJump],
		)

		if (!shown) {
			return null
		}

		const activeIndex = active !== null && active < turns.length ? active : null
		const activeTurn = activeIndex === null ? undefined : turns[activeIndex]
		const activeTop = activeIndex === null ? 0 : minimapTopPercent(activeIndex, turns.length)
		// The first and last previews hang from their strip instead of centering, so they stay on screen.
		const previewShift = activeIndex === 0 ? "0%" : activeIndex === turns.length - 1 ? "-100%" : "-50%"
		const status = activeTurn && minimapTurnStatus(activeTurn)
		const previous = current !== undefined && current > 0 ? current - 1 : undefined
		const next = current !== undefined && current < turns.length - 1 ? current + 1 : undefined
		const indexFromPointer = (event: React.MouseEvent<HTMLElement>) => {
			const rect = event.currentTarget.getBoundingClientRect()
			return minimapIndexFromPointer(turns.length, rect.top, rect.height, event.clientY)
		}
		const move = (delta: number) =>
			setActive((index) => Math.max(0, Math.min(turns.length - 1, (index ?? current ?? 0) + delta)))

		return (
			<div
				className={cn(
					"group/minimap relative flex w-4 shrink-0 flex-col items-center justify-center select-none",
					width < WIDE_CHAT_WIDTH &&
						"opacity-60 transition-opacity duration-150 focus-within:opacity-100 hover:opacity-100 motion-reduce:transition-none",
				)}
				data-testid="chat-minimap"
				ref={columnRef}>
				<StepButton direction="previous" onClick={() => previous !== undefined && jump(previous)} target={previous} />
				<div className="relative w-full" style={{ height: `min(${(turns.length - 1) * STRIP_SPACING}px, 100% - 56px)` }}>
					<button
						aria-label={`Jump to turn: ${activeTurn?.prompt || "Your prompt"}`}
						className="absolute inset-0 cursor-pointer border-0 bg-transparent p-0 focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-(--vscode-focusBorder)"
						data-testid="chat-minimap-rail"
						onBlur={() => setActive(null)}
						onClick={(event) => {
							const index = indexFromPointer(event)
							if (index !== null) {
								jump(index)
							}
							event.currentTarget.blur()
						}}
						onFocus={() => setActive((index) => index ?? current ?? 0)}
						onKeyDown={(event) => {
							if (event.key === "ArrowDown" || event.key === "ArrowUp") {
								event.preventDefault()
								move(event.key === "ArrowDown" ? 1 : -1)
							} else if (event.key === "Home" || event.key === "End") {
								event.preventDefault()
								setActive(event.key === "Home" ? 0 : turns.length - 1)
							} else if ((event.key === "Enter" || event.key === " ") && activeIndex !== null) {
								event.preventDefault()
								jump(activeIndex)
							} else if (event.key === "Escape") {
								event.currentTarget.blur()
							}
						}}
						onMouseDown={(event) => event.preventDefault()}
						onMouseLeave={() => setActive(null)}
						onMouseMove={(event) => setActive(indexFromPointer(event))}
						type="button">
						<span aria-hidden className="absolute inset-y-0 right-[7px] w-px bg-minimap-rail" />
						{turns.map((turn, index) => {
							const distance = activeIndex === null ? null : Math.abs(index - activeIndex)
							const attention = turn.attention && ATTENTION_FILL[turn.attention]
							return (
								// Transform and opacity only: in-view and the fisheye change on every scroll tick.
								<span
									aria-hidden
									className={cn(
										"absolute right-0.5 h-0.5 w-3 origin-right -translate-y-1/2 rounded-full transition-transform duration-150 motion-reduce:transition-none",
										attention ?? "bg-description",
										!attention && (distance === 0 ? "opacity-80" : "opacity-40"),
										distance === null || distance === 0
											? "scale-x-100"
											: distance === 1
												? "scale-x-[0.667]"
												: distance === 2
													? "scale-x-[0.417]"
													: "scale-x-[0.333]",
										turn.streaming && "animate-minimap-live [--minimap-fill:var(--color-description)]",
									)}
									data-attention={turn.attention}
									data-current={index === current || undefined}
									data-in-view={inView.has(index)}
									data-testid="chat-minimap-strip"
									key={minimapTurnKey(turn)}
									style={{ top: `${minimapTopPercent(index, turns.length)}%` }}>
									<span
										className={cn(
											"absolute inset-0 rounded-full bg-foreground opacity-0 transition-opacity duration-150 motion-reduce:transition-none",
											inView.has(index) && !attention && "opacity-90",
										)}
									/>
								</span>
							)
						})}
					</button>
					{activeTurn && (
						<div
							className="pointer-events-none absolute right-[calc(100%+6px)] z-20 w-[min(20rem,calc(100vw-48px))] rounded-xs border border-solid border-hover-widget-border bg-hover-widget p-2 text-left text-hover-widget-foreground shadow-md"
							data-testid="chat-minimap-preview"
							style={{ top: `${activeTop}%`, transform: `translateY(${previewShift})` }}>
							<div className="truncate text-[12px] font-medium leading-5">
								{activeTurn.prompt || "Before your first message"}
							</div>
							{activeTurn.reply && (
								<div className="mt-0.5 line-clamp-3 text-[12px] leading-[18px] text-description">
									{activeTurn.reply}
								</div>
							)}
							{status && (
								<div
									className={cn(
										"mt-1 text-[11px] text-description",
										activeTurn.attention === "error" && "text-error",
										(activeTurn.attention === "approval" || activeTurn.attention === "question") &&
											"text-warning",
									)}>
									{status}
								</div>
							)}
						</div>
					)}
				</div>
				<StepButton direction="next" onClick={() => next !== undefined && jump(next)} target={next} />
			</div>
		)
	},
)

MiniMap.displayName = "MiniMap"

/** Previous / next turn: shown while the pointer or focus is on the minimap. */
function StepButton({
	direction,
	target,
	onClick,
}: {
	direction: "previous" | "next"
	target: number | undefined
	onClick: () => void
}) {
	const label = direction === "previous" ? "Previous turn" : "Next turn"
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<button
					aria-label={label}
					className="my-1 flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-xs border-0 bg-transparent p-0 text-description opacity-0 transition-opacity duration-150 group-hover/minimap:opacity-100 group-focus-within/minimap:opacity-100 hover:bg-toolbar-hover hover:text-foreground focus-visible:outline focus-visible:outline-1 focus-visible:outline-(--vscode-focusBorder) disabled:cursor-default disabled:opacity-0 motion-reduce:transition-none"
					disabled={target === undefined}
					onClick={onClick}
					type="button">
					<span
						aria-hidden
						className={`codicon codicon-chevron-${direction === "previous" ? "up" : "down"} text-[12px]!`}
					/>
				</button>
			</TooltipTrigger>
			<TooltipContent side="left">{label}</TooltipContent>
		</Tooltip>
	)
}
