import { type ReactNode, useLayoutEffect, useRef, useState } from "react"
import { cn } from "@/lib/utils"

/** The pill's full width: its current width plus whatever its truncating label is hiding. */
function naturalWidth(slot: HTMLElement): number {
	const pill = slot.firstElementChild as HTMLElement | null
	if (!pill) return 0
	const label = pill.querySelector<HTMLElement>(".truncate")
	const hidden = label ? Math.max(0, label.scrollWidth - label.clientWidth) : 0
	return Math.ceil(pill.offsetWidth + hidden)
}

/**
 * A composer row slot for a truncating pill (where pill, configuration, effort).
 * The row may squeeze it down to `floor` px, but it never reserves more room than
 * the pill needs: a short label ("Med") sits right next to whatever follows it.
 */
export function ShrinkSlot({ floor, className, children }: { floor: number; className?: string; children: ReactNode }) {
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
			style={{ minWidth: natural ? Math.min(floor, natural) : floor }}>
			{children}
		</span>
	)
}
