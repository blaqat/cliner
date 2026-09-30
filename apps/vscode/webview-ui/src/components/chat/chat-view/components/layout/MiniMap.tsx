import type { ClineMessage } from "@shared/ExtensionMessage"
import type React from "react"
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { getCurrentMinimapItem, getMinimapItems, type MinimapKind, minimapItemKey } from "../../utils/minimapUtils"

// Below this chat width the rail takes too much room from the messages.
const MIN_CHAT_WIDTH = 280
// Rows hidden under the sticky user message header don't count as "at the top".
const TOP_INSET = 32
// The list follows new output: the last turn is current.
const LIVE_END = Number.MAX_SAFE_INTEGER

// Each square's fill, exposed as --minimap-fill so the streaming fade dims the same color.
// The current square is marked with an outline, which stays legible on every fill.
const KIND_FILL: Record<MinimapKind, string> = {
	user: "bg-minimap-user [--minimap-fill:var(--color-minimap-user)]",
	agent: "bg-minimap-agent [--minimap-fill:var(--color-minimap-agent)]",
	completion: "bg-minimap-completion [--minimap-fill:var(--color-minimap-completion)]",
	answer: "bg-minimap-answer [--minimap-fill:var(--color-minimap-answer)]",
	question: "bg-minimap-question [--minimap-fill:var(--color-minimap-question)]",
}

interface MiniMapProps {
	/** The unfiltered transcript (after the task prompt): turn boundaries come from here. */
	messages: ClineMessage[]
	/** The rendered (grouped) list: jump targets index into it. */
	rows: (ClineMessage | ClineMessage[])[]
	/** The task prompt: rendered in the header, shown as the first user square. */
	task?: ClineMessage
	/** Changes when the list remounts (task switch), so the scroll listener re-attaches. */
	listKey: number
	scrollContainerRef: React.RefObject<HTMLDivElement>
	/** Set while the user has scrolled away from the live end (auto-follow is off). */
	autoScrollDisabledRef: React.RefObject<boolean>
	/** The backend reports a streaming turn: the last reply square shows it's in progress. */
	turnActive: boolean
	onJump: (index: number) => void
}

/**
 * Vertical rail at the right edge of the chat: one square per user message, each
 * followed by one square for the agent's reply to that turn. Hover shows a snippet,
 * click jumps to the row. The rail is bounded by the chat height and scrolls itself.
 */
export const MiniMap = memo(
	({ messages, rows, task, listKey, scrollContainerRef, autoScrollDisabledRef, turnActive, onJump }: MiniMapProps) => {
		const items = useMemo(() => getMinimapItems(messages, rows, task, turnActive), [messages, rows, task, turnActive])
		const [wide, setWide] = useState(true)
		const [topIndex, setTopIndex] = useState(LIVE_END)
		const navRef = useRef<HTMLElement | null>(null)
		const currentButtonRef = useRef<HTMLButtonElement | null>(null)

		useEffect(() => {
			const container = scrollContainerRef.current
			if (!container || typeof ResizeObserver === "undefined") {
				return
			}
			const observer = new ResizeObserver(([entry]) => setWide(entry.contentRect.width >= MIN_CHAT_WIDTH))
			observer.observe(container)
			return () => observer.disconnect()
		}, [scrollContainerRef])

		// Track the row at the top of the viewport from Virtuoso's rendered items. While the list
		// follows new output, streaming rows grow and get re-measured, so the top row wobbles across
		// a turn boundary on every pin-to-bottom; the reader is at the live end, so pin to it instead
		// and only measure once the user has scrolled away.
		useEffect(() => {
			const scroller = scrollContainerRef.current?.querySelector<HTMLElement>('[data-virtuoso-scroller="true"]')
			if (!scroller) {
				return
			}
			let frame = 0
			const measure = () => {
				frame = 0
				if (!autoScrollDisabledRef.current) {
					setTopIndex(LIVE_END)
					return
				}
				const top = scroller.getBoundingClientRect().top + TOP_INSET
				for (const el of scroller.querySelectorAll<HTMLElement>("[data-index]")) {
					if (el.getBoundingClientRect().bottom > top) {
						setTopIndex(Number(el.dataset.index))
						return
					}
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
		}, [scrollContainerRef, autoScrollDisabledRef, listKey, items.length])

		const current = getCurrentMinimapItem(items, topIndex)
		const currentKey = current ? minimapItemKey(current) : undefined

		// Keep the current square in view when the rail itself scrolls. Scrolls only the rail:
		// scrollIntoView would also move the chat's (overflow-hidden) ancestors.
		useEffect(() => {
			const nav = navRef.current
			const button = currentButtonRef.current
			if (!nav || !button || currentKey === undefined) {
				return
			}
			const navRect = nav.getBoundingClientRect()
			const buttonRect = button.getBoundingClientRect()
			if (buttonRect.top < navRect.top) {
				nav.scrollTop -= navRect.top - buttonRect.top
			} else if (buttonRect.bottom > navRect.bottom) {
				nav.scrollTop += buttonRect.bottom - navRect.bottom
			}
		}, [currentKey])

		const handleJump = useCallback(
			(index: number) => {
				setTopIndex(index)
				onJump(index)
			},
			[onJump],
		)

		if (!wide || items.length < 2) {
			return null
		}

		return (
			<nav
				aria-label="Conversation minimap"
				className="w-[18px] min-h-0 max-h-full shrink-0 flex flex-col overflow-y-auto overscroll-contain border-l border-minimap-rail [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
				data-testid="chat-minimap"
				ref={navRef}>
				<div className="my-auto flex flex-col items-center gap-[3px] py-1.5">
					{items.map((item) => {
						const key = minimapItemKey(item)
						const isCurrent = key === currentKey
						const label = item.role === "user" ? "You" : "Cline"
						return (
							<Tooltip key={key}>
								<TooltipTrigger asChild>
									<button
										aria-current={isCurrent ? "location" : undefined}
										aria-label={`Jump to ${label}: ${item.snippet}`}
										className={cn(
											"block size-2.5 shrink-0 rounded-[2px] border-0 p-0 cursor-pointer transition-transform duration-100 hover:scale-135 motion-reduce:transition-none",
											KIND_FILL[item.kind],
											isCurrent && "outline outline-1 outline-offset-1 outline-minimap-current",
											item.streaming && "animate-minimap-live",
										)}
										data-kind={item.kind}
										data-role={item.role}
										onClick={() => handleJump(item.index)}
										ref={isCurrent ? currentButtonRef : undefined}
										type="button"
									/>
								</TooltipTrigger>
								<TooltipContent
									className="max-w-64 border-hover-widget-border bg-hover-widget text-hover-widget-foreground"
									showArrow={false}
									side="left">
									<b>{label}</b>
									<br />
									{item.snippet}
								</TooltipContent>
							</Tooltip>
						)
					})}
				</div>
			</nav>
		)
	},
)

MiniMap.displayName = "MiniMap"
