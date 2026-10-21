import { type ReactNode, useLayoutEffect, useRef, useState } from "react"
import { cn } from "@/lib/utils"

/**
 * The pill's full (unsqueezed) width, measured on a hidden copy laid out at
 * max-content beside the slot. Reading the live pill would see its squeezed
 * width wherever a wrapper, not the label itself, clips the text.
 */
function naturalWidth(slot: HTMLElement): number {
	const pill = slot.firstElementChild as HTMLElement | null
	const host = slot.parentElement
	if (!pill || !host) return 0
	const copy = pill.cloneNode(true) as HTMLElement
	for (const element of [copy, ...copy.querySelectorAll<HTMLElement>("[id]")]) element.removeAttribute("id")
	copy.setAttribute("aria-hidden", "true")
	Object.assign(copy.style, {
		position: "absolute",
		visibility: "hidden",
		pointerEvents: "none",
		left: "0",
		top: "0",
		width: "max-content",
		minWidth: "0",
		maxWidth: "none",
	})
	// Outside the slot, so the slot's own mutation observer doesn't see it.
	host.appendChild(copy)
	const width = copy.getBoundingClientRect().width
	copy.remove()
	return Math.ceil(width)
}

/**
 * A composer row slot for a truncating pill (where pill, configuration, effort).
 * The row may squeeze it down to `floor` px, but it never reserves more room than
 * the pill needs: a short label ("Med") sits right next to whatever follows it.
 */
export function ShrinkSlot({
	floor,
	shrink = 1,
	className,
	children,
}: {
	floor: number
	/** How much of the squeeze this slot takes relative to the others (flex-shrink). */
	shrink?: number
	className?: string
	children: ReactNode
}) {
	const ref = useRef<HTMLSpanElement>(null)
	const [natural, setNatural] = useState<number>()

	useLayoutEffect(() => {
		const slot = ref.current
		if (!slot) return
		const measure = () => setNatural(naturalWidth(slot))
		measure()
		if (typeof ResizeObserver === "undefined") return
		const resize = new ResizeObserver(measure)
		resize.observe(slot)
		if (slot.firstElementChild) resize.observe(slot.firstElementChild)
		// A new label can change the full width without changing a squeezed pill's size.
		const mutations = new MutationObserver(measure)
		mutations.observe(slot, { subtree: true, childList: true, characterData: true })
		return () => {
			resize.disconnect()
			mutations.disconnect()
		}
	}, [])

	return (
		<span
			className={cn("flex empty:hidden", className)}
			data-floor={floor}
			data-shrink=""
			ref={ref}
			style={{ minWidth: natural ? Math.min(floor, natural) : floor, flexShrink: shrink }}>
			{children}
		</span>
	)
}
