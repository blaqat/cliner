import { type ReactNode, type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { cn } from "@/lib/utils"
import { placeWheel, WHEEL_ROW_HEIGHT, WHEEL_VIEWPORT_MARGIN, type WheelPlacement } from "./wheelPlacement"

export interface WheelItem {
	value: string
	label: string
	/** Muted text after the label (a provider, "not saved"). */
	detail?: string
}

/** Horizontal padding of a wheel row; the row's text starts this far in. */
const ROW_INSET = 8
/** Trackpads send many small deltas; one row per this many px of scroll. */
const SCROLL_STEP = 28
const FADE_MASK = "linear-gradient(to bottom, transparent 0, #000 30%, #000 70%, transparent 100%)"

interface WheelPopupProps {
	open: boolean
	/** The chip text the wheel opens over; its center row lines up with it. */
	anchorRef: RefObject<HTMLElement | null>
	/** The chip button: focus returns here, and clicks on it are its own (toggle), not "outside". */
	triggerRef: RefObject<HTMLElement | null>
	label: string
	/** The wheel's choices; omit for a popup without a wheel (permissions only). */
	items?: WheelItem[]
	value?: string
	/** Called once on close with the kept choice, only when it differs from `value`. */
	onPick?: (value: string) => void
	onClose: () => void
	/** True while the wheel's center row sits exactly over the chip text (the chip hides its copy). */
	onAlignedChange?: (aligned: boolean) => void
	/** Above the wheel (permissions). */
	header?: ReactNode
	/** Below the wheel (Reset, Models page). */
	footer?: ReactNode
	/** Popup width in px (capped to the window). */
	width: number
	testId: string
}

/**
 * The chip's wheel: the current pick sits centered over the chip text it came from, neighbours
 * above and below fade out at the edges, and a band marks the center row. Scroll, ↑/↓ (Home/End,
 * PageUp/PageDown) or click a row. Enter, a row click, a click outside or Tab away keep the
 * choice; Escape puts the previous one back. It may leave the composer but always stays fully on
 * screen (it shifts up near the bottom edge; a short window shows fewer rows). Focus moves into
 * the wheel on open and back to the chip on close. Only the popup itself ever scrolls (as a last
 * resort, without a wheel), so it never has two scrollbars.
 */
export function WheelPopup({
	open,
	anchorRef,
	triggerRef,
	label,
	items,
	value,
	onPick,
	onClose,
	onAlignedChange,
	header,
	footer,
	width,
	testId,
}: WheelPopupProps) {
	const rootRef = useRef<HTMLDivElement>(null)
	const viewportRef = useRef<HTMLDivElement>(null)
	const listboxRef = useRef<HTMLDivElement>(null)
	const hasWheel = !!items && items.length > 0
	const startIndex = () => Math.max(0, items?.findIndex((item) => item.value === value) ?? 0)
	const [index, setIndex] = useState(startIndex)
	const indexRef = useRef(index)
	indexRef.current = index
	const [placement, setPlacement] = useState<WheelPlacement>()
	const closedRef = useRef(false)

	// biome-ignore lint/correctness/useExhaustiveDependencies: a fresh open starts at the current value
	useLayoutEffect(() => {
		if (!open) return
		closedRef.current = false
		setIndex(startIndex())
		setPlacement(undefined)
	}, [open])

	const finish = useCallback(
		(keep: boolean, at = indexRef.current, restoreFocus = true) => {
			if (closedRef.current) return
			closedRef.current = true
			const picked = items?.[at]
			if (keep && picked && picked.value !== value) onPick?.(picked.value)
			onAlignedChange?.(false)
			onClose()
			if (restoreFocus) triggerRef.current?.focus()
		},
		[items, value, onPick, onAlignedChange, onClose, triggerRef],
	)

	const move = useCallback(
		(delta: number) => {
			if (!items?.length) return
			setIndex((current) => Math.max(0, Math.min(items.length - 1, current + delta)))
		},
		[items],
	)

	// Placement: measured before paint, again when the window or the popup's content changes size.
	const measure = useCallback(() => {
		const root = rootRef.current
		const anchor = anchorRef.current ?? triggerRef.current
		if (!root || !anchor) return
		const rootRect = root.getBoundingClientRect()
		const viewportRect = viewportRef.current?.getBoundingClientRect()
		const anchorRect = anchor.getBoundingClientRect()
		const above = viewportRect ? viewportRect.top - rootRect.top : rootRect.height
		const below = viewportRect ? rootRect.bottom - viewportRect.bottom : 0
		const inset = (viewportRect ? viewportRect.left - rootRect.left : 0) + ROW_INSET
		const next = placeWheel({
			anchor: { left: anchorRect.left, top: anchorRect.top, height: anchorRect.height },
			viewport: { width: window.innerWidth, height: window.innerHeight },
			popup: { width: Math.min(width, window.innerWidth - 2 * WHEEL_VIEWPORT_MARGIN), above, below },
			rowInset: inset,
			noWheel: !hasWheel,
		})
		setPlacement((current) =>
			current &&
			current.top === next.top &&
			current.left === next.left &&
			current.rows === next.rows &&
			current.columnOffset === next.columnOffset &&
			current.aligned === next.aligned
				? current
				: next,
		)
	}, [anchorRef, triggerRef, width, hasWheel])

	useLayoutEffect(() => {
		if (!open) return
		measure()
		const root = rootRef.current
		window.addEventListener("resize", measure)
		const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(() => measure())
		if (root) observer?.observe(root)
		return () => {
			window.removeEventListener("resize", measure)
			observer?.disconnect()
		}
	}, [open, measure])

	useEffect(() => {
		if (open && placement) onAlignedChange?.(placement.aligned)
	}, [open, placement, onAlignedChange])

	// Focus moves into the wheel (or the popup, without one) once it is placed.
	const placed = !!placement
	useEffect(() => {
		if (!open || !placed) return
		;(listboxRef.current ?? rootRef.current)?.focus({ preventScroll: true })
	}, [open, placed])

	// A click anywhere else keeps the choice and closes; the chip's own click toggles it instead.
	useEffect(() => {
		if (!open) return
		const onPointerDown = (event: PointerEvent) => {
			const target = event.target as Node | null
			if (!target || rootRef.current?.contains(target) || triggerRef.current?.contains(target)) return
			finish(true, indexRef.current, false)
		}
		document.addEventListener("pointerdown", onPointerDown, true)
		return () => document.removeEventListener("pointerdown", onPointerDown, true)
	}, [open, finish, triggerRef])

	// Mouse wheel and trackpad: one row per notch, or per SCROLL_STEP px of a trackpad swipe.
	useEffect(() => {
		const viewport = viewportRef.current
		if (!open || !viewport) return
		let accumulated = 0
		const onWheel = (event: WheelEvent) => {
			event.preventDefault()
			const delta = event.deltaMode === 1 ? event.deltaY * WHEEL_ROW_HEIGHT : event.deltaY
			accumulated += delta
			if (Math.abs(accumulated) >= SCROLL_STEP || Math.abs(delta) >= SCROLL_STEP) {
				move(accumulated > 0 ? 1 : -1)
				accumulated = 0
			}
		}
		viewport.addEventListener("wheel", onWheel, { passive: false })
		return () => viewport.removeEventListener("wheel", onWheel)
	}, [open, placed, move])

	if (!open || typeof document === "undefined") return null

	const rows = placement?.rows ?? 5
	const center = Math.floor(rows / 2)
	const activeId = `${testId}-option-${index}`

	return createPortal(
		<div
			aria-label={label}
			className="fixed z-50 flex flex-col overflow-y-auto overscroll-contain rounded-xs border border-solid border-menu-foreground/10 bg-menu p-1 text-[12px] text-menu-foreground shadow-md outline-none [scrollbar-width:thin]"
			data-aligned={placement?.aligned ? "true" : undefined}
			data-rows={hasWheel ? rows : 0}
			data-testid={testId}
			onBlur={(event) => {
				const next = event.relatedTarget as Node | null
				if (next && !rootRef.current?.contains(next) && !triggerRef.current?.contains(next)) {
					finish(true, indexRef.current, false)
				}
			}}
			onKeyDown={(event) => {
				if (event.key === "Escape") {
					event.preventDefault()
					event.stopPropagation()
					finish(false)
				}
			}}
			ref={rootRef}
			role="dialog"
			style={{
				top: placement?.top ?? 0,
				left: placement?.left ?? 0,
				width: `min(${width}px, calc(100vw - ${2 * WHEEL_VIEWPORT_MARGIN}px))`,
				maxHeight: `calc(100vh - ${2 * WHEEL_VIEWPORT_MARGIN}px)`,
				visibility: placement ? undefined : "hidden",
			}}
			tabIndex={-1}>
			{header}
			{hasWheel && (
				<div
					className="relative shrink-0 overflow-hidden"
					data-testid={`${testId}-viewport`}
					ref={viewportRef}
					style={{
						height: rows * WHEEL_ROW_HEIGHT,
						maskImage: rows >= 3 ? FADE_MASK : undefined,
						WebkitMaskImage: rows >= 3 ? FADE_MASK : undefined,
					}}>
					<div
						aria-activedescendant={activeId}
						aria-label={label}
						className="peer relative z-[1] outline-none transition-transform duration-150 ease-out motion-reduce:transition-none [.vscode-reduce-motion_&]:transition-none"
						data-testid={`${testId}-list`}
						onKeyDown={(event) => {
							const page = Math.max(1, rows - 1)
							const step: Record<string, number> = {
								ArrowUp: -1,
								ArrowDown: 1,
								PageUp: -page,
								PageDown: page,
								Home: -Infinity,
								End: Infinity,
							}
							if (event.key in step) {
								event.preventDefault()
								const delta = step[event.key]
								if (delta === -Infinity) setIndex(0)
								else if (delta === Infinity) setIndex((items?.length ?? 1) - 1)
								else move(delta)
							} else if (event.key === "Enter" || event.key === " ") {
								event.preventDefault()
								finish(true)
							}
						}}
						ref={listboxRef}
						role="listbox"
						style={{
							transform: `translateY(${(center - index) * WHEEL_ROW_HEIGHT}px)`,
							paddingLeft: placement?.columnOffset ?? 0,
						}}
						tabIndex={0}>
						{items.map((item, i) => (
							<div
								aria-selected={i === index}
								className={cn(
									"flex min-w-0 cursor-pointer items-center gap-1.5 whitespace-nowrap",
									i === index ? "text-menu-foreground" : "text-description hover:text-menu-foreground",
								)}
								data-testid="wheel-option"
								id={`${testId}-option-${i}`}
								key={item.value}
								onClick={() => {
									setIndex(i)
									finish(true, i)
								}}
								role="option"
								// Pixels, not rem: the band and the slide are measured in WHEEL_ROW_HEIGHT px.
								style={{ height: WHEEL_ROW_HEIGHT, paddingInline: ROW_INSET }}>
								<span className="min-w-0 truncate">{item.label}</span>
								{item.detail && (
									<span className="min-w-0 shrink truncate text-[11px] text-description">{item.detail}</span>
								)}
							</div>
						))}
					</div>
					{/* After the list (painted under it) so the list's keyboard focus can ring the band. */}
					<div
						aria-hidden
						className="pointer-events-none absolute inset-x-0 z-0 rounded-xs bg-list-hover peer-focus-visible:outline peer-focus-visible:outline-1 peer-focus-visible:-outline-offset-1 peer-focus-visible:outline-(--vscode-focusBorder)"
						data-testid={`${testId}-band`}
						style={{ top: center * WHEEL_ROW_HEIGHT, height: WHEEL_ROW_HEIGHT }}
					/>
				</div>
			)}
			{footer}
		</div>,
		document.body,
	)
}
