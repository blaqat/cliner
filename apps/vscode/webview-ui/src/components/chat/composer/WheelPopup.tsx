import { type ReactNode, type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { cn } from "@/lib/utils"
import { placeWheel, WHEEL_ROW_HEIGHT, WHEEL_VIEWPORT_MARGIN, type WheelPlacement } from "./wheelPlacement"

export interface WheelItem {
	value: string
	label: string
	/** More about the choice (a provider, "not saved"): in the row's tooltip, so the rolling text stays one word. */
	detail?: string
}

/** Horizontal padding of a wheel row: the chip's own part padding, so the row text starts where the chip text did. */
export const WHEEL_ROW_INSET = 4
/** Trackpads send many small deltas; one row per this many px of scroll. */
const SCROLL_STEP = 28

/** Neighbours fade with their distance from the pick. */
export const WHEEL_ROW_OPACITY = [1, 0.6, 0.38, 0.24, 0.16]

interface WheelPopupProps {
	open: boolean
	/** The chip text the wheel rolls in place of; the pick's row lines up with it. */
	anchorRef: RefObject<HTMLElement | null>
	/** The chip button: focus returns here, and clicks on it are its own (toggle), not "outside". */
	triggerRef: RefObject<HTMLElement | null>
	label: string
	/** The wheel's choices; omit for approvals only. */
	items?: WheelItem[]
	value?: string
	/** Called once on close with the kept choice, only when it differs from `value`. */
	onPick?: (value: string) => void
	onClose: () => void
	/** True while the pick's row sits exactly over the chip text (the chip hides its copy). */
	onAlignedChange?: (aligned: boolean) => void
	/** Just above the rolling text (the approvals row). */
	header?: ReactNode
	/** Small icon buttons right beside the pick's row (Reset, Next message only, Models page). */
	actions?: ReactNode
	/** A short line beside the actions ("No saved models yet"). */
	note?: ReactNode
	testId: string
}

/**
 * The chip's wheel, embedded in the chip text: no menu box, border or shadow. The pick sits exactly
 * where the chip text was (in the chip's font) and its neighbours roll above and below, fading out;
 * the pick reads in the foreground color, the rest muted. Each row sits on the composer's own
 * color, only as wide as its text, so it stays legible over the draft and covers nothing else. Scroll, ↑/↓ (Home/End, PageUp/PageDown)
 * or click a row. Enter, a row click, a click outside or Tab away keep the choice; Escape puts the
 * previous one back. Shift+Tab from the wheel reaches the icon actions left of the pick (and, on
 * the effort wheel, the approvals row above). It always stays on screen: with no room below, more rows go above. Focus moves into the
 * wheel on open and back to the chip on close. Nothing in it scrolls but the wheel itself.
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
	actions,
	note,
	testId,
}: WheelPopupProps) {
	const rootRef = useRef<HTMLDivElement>(null)
	const headerRef = useRef<HTMLDivElement>(null)
	const actionsRef = useRef<HTMLDivElement>(null)
	const [headerShift, setHeaderShift] = useState(0)
	const viewportRef = useRef<HTMLDivElement>(null)
	const listboxRef = useRef<HTMLDivElement>(null)
	const hasWheel = !!items && items.length > 0
	const startIndex = () => Math.max(0, items?.findIndex((item) => item.value === value) ?? 0)
	const count = items?.length ?? 0
	const [index, setIndex] = useState(startIndex)
	const indexRef = useRef(index)
	indexRef.current = index
	const [placement, setPlacement] = useState<WheelPlacement>()
	const [keyboardFocus, setKeyboardFocus] = useState(false)
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

	const flipRef = useRef(false)
	/** Moves the pick by `delta` rows on screen (down is positive), whichever way the wheel rolls. */
	const move = useCallback(
		(delta: number) => {
			if (!items?.length) return
			const step = flipRef.current ? -delta : delta
			setIndex((current) => Math.max(0, Math.min(items.length - 1, current + step)))
		},
		[items],
	)

	// Placement: measured before paint, again when the window or the wheel's content changes size.
	const measure = useCallback(() => {
		const root = rootRef.current
		const anchor = anchorRef.current ?? triggerRef.current
		if (!root || !anchor) return
		const rootRect = root.getBoundingClientRect()
		const anchorRect = anchor.getBoundingClientRect()
		const headerRect = headerRef.current?.getBoundingClientRect()
		const next = placeWheel({
			anchor: { left: anchorRect.left, top: anchorRect.top, height: anchorRect.height },
			viewport: { width: window.innerWidth, height: window.innerHeight },
			popup: { width: rootRect.width, header: headerRect ? headerRect.height + 4 : 0 },
			rowInset: WHEEL_ROW_INSET,
			lead: hasWheel ? (actionsRef.current?.getBoundingClientRect().width ?? 0) : 0,
			count,
			index: indexRef.current,
			noWheel: !hasWheel,
		})
		// The approvals row above may be wider than the wheel: it shifts left on its own to stay on screen.
		if (hasWheel && headerRect) {
			const overflow = next.left + headerRect.width - (window.innerWidth - WHEEL_VIEWPORT_MARGIN)
			setHeaderShift(-Math.max(0, Math.min(overflow, next.left - WHEEL_VIEWPORT_MARGIN)))
		}
		setPlacement((current) => {
			if (!current) return next
			if (
				current.top === next.top &&
				current.left === next.left &&
				current.above === next.above &&
				current.below === next.below &&
				current.aligned === next.aligned
			) {
				return current
			}
			// The roll direction is decided once per open; a resize doesn't turn the wheel over.
			return { ...next, flip: current.flip }
		})
	}, [anchorRef, triggerRef, hasWheel, count])

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

	const above = placement?.above ?? 2
	const below = placement?.below ?? 2
	const flip = placement?.flip ?? false
	flipRef.current = flip
	const rows = above + 1 + below
	const activeId = `${testId}-option-${index}`
	// On screen, top to bottom.
	const shown = items ? (flip ? items.map((item, i) => ({ item, i })).reverse() : items.map((item, i) => ({ item, i }))) : []
	const displayIndex = flip ? count - 1 - index : index

	return createPortal(
		<div
			aria-label={label}
			className="fixed z-50 flex flex-col items-start text-xs outline-none"
			data-above={hasWheel ? above : undefined}
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
				maxWidth: `calc(100vw - ${2 * WHEEL_VIEWPORT_MARGIN}px)`,
				visibility: placement ? undefined : "hidden",
			}}
			tabIndex={-1}>
			{!hasWheel && (header || actions || note) && (
				<div className="flex max-w-full flex-col items-start gap-0.5" ref={headerRef}>
					{header}
					{(actions || note) && (
						<div className="flex items-center gap-1 rounded-xs bg-input-background px-1 text-[11px] text-description">
							{note}
							{actions}
						</div>
					)}
				</div>
			)}
			{hasWheel && (
				<div className="relative flex max-w-full items-start">
					{header && (
						// Above the rolling text; shifts left on its own if it's wider than the room to the right.
						<div
							className="absolute bottom-full left-0 mb-1 w-max"
							ref={headerRef}
							style={{
								maxWidth: `calc(100vw - ${2 * WHEEL_VIEWPORT_MARGIN}px)`,
								transform: headerShift ? `translateX(${headerShift}px)` : undefined,
							}}>
							{header}
						</div>
					)}
					{(actions || note) && (
						// Left of the pick's line, so they never cover the chip's other text or Send.
						<div
							className="flex shrink-0 items-center gap-0.5 rounded-xs bg-input-background pl-0.5 text-[11px] text-description"
							data-testid={`${testId}-actions`}
							ref={actionsRef}
							style={{ marginTop: above * WHEEL_ROW_HEIGHT, height: WHEEL_ROW_HEIGHT }}>
							{note && <span className="px-1 whitespace-nowrap">{note}</span>}
							{actions}
						</div>
					)}
					<div
						className="relative min-w-0 shrink overflow-hidden"
						data-testid={`${testId}-viewport`}
						ref={viewportRef}
						style={{ height: rows * WHEEL_ROW_HEIGHT }}>
						<div
							aria-activedescendant={activeId}
							aria-label={label}
							className="relative flex flex-col items-start outline-none transition-transform duration-150 ease-out motion-reduce:transition-none [.vscode-reduce-motion_&]:transition-none"
							data-testid={`${testId}-list`}
							onBlur={() => setKeyboardFocus(false)}
							onFocus={(event) => {
								try {
									setKeyboardFocus(event.currentTarget.matches(":focus-visible"))
								} catch {
									setKeyboardFocus(false)
								}
							}}
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
									const first = flip ? count - 1 : 0
									const last = flip ? 0 : count - 1
									if (delta === -Infinity) setIndex(first)
									else if (delta === Infinity) setIndex(last)
									else move(delta)
								} else if (event.key === "Enter" || event.key === " ") {
									event.preventDefault()
									finish(true)
								}
							}}
							ref={listboxRef}
							role="listbox"
							style={{ transform: `translateY(${(above - displayIndex) * WHEEL_ROW_HEIGHT}px)` }}
							tabIndex={0}>
							{shown.map(({ item, i }, row) => (
								<div
									aria-selected={i === index}
									className={cn(
										// Each row's own text width, on the composer's color: it covers only what it reads over.
										"flex w-max max-w-full min-w-0 shrink-0 cursor-pointer items-center whitespace-nowrap rounded-xs bg-input-background",
										i === index ? "text-foreground" : "group/row text-description hover:text-foreground",
										i === index &&
											keyboardFocus &&
											"outline outline-1 -outline-offset-1 outline-(--vscode-focusBorder)",
									)}
									data-testid="wheel-option"
									id={`${testId}-option-${i}`}
									key={item.value}
									onClick={() => {
										setIndex(i)
										finish(true, i)
									}}
									role="option"
									// Pixels, not rem: the slide is measured in WHEEL_ROW_HEIGHT px.
									style={{ height: WHEEL_ROW_HEIGHT, paddingInline: WHEEL_ROW_INSET }}
									title={item.detail ? `${item.label} · ${item.detail}` : undefined}>
									<span
										className="min-w-0 truncate transition-opacity duration-150 group-hover/row:opacity-100! motion-reduce:transition-none"
										data-testid="wheel-option-text"
										style={{
											opacity:
												WHEEL_ROW_OPACITY[
													Math.min(Math.abs(row - displayIndex), WHEEL_ROW_OPACITY.length - 1)
												],
										}}>
										{item.label}
									</span>
								</div>
							))}
						</div>
					</div>
				</div>
			)}
		</div>,
		document.body,
	)
}
