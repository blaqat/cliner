import type React from "react"
import { type RefObject, useEffect, useRef, useState } from "react"
import { cn } from "@/lib/utils"

/** One wheel row (px): the slide is measured in rows, so it is pixels, not rem. */
export const WHEEL_ROW_HEIGHT = 24
/** Rows on show: the pick in the middle and two neighbours above and below. */
export const WHEEL_VISIBLE_ROWS = 5
const MIDDLE_ROW = Math.floor(WHEEL_VISIBLE_ROWS / 2)
/** Trackpads send many small deltas; one row per this many px of scroll. */
const SCROLL_STEP = 28

export interface WheelItem {
	value: string
	label: string
	/** More about the choice (a model id, "Provider default"): the row's tooltip. */
	detail?: string
}

export interface WheelColumnSpec {
	label: string
	items: WheelItem[]
	index: number
	onSelect: (index: number) => void
	/** Can't change (a locked choice, or a model without reasoning): shown, but inert. */
	disabled?: boolean
	/** Why it can't change. */
	disabledReason?: string
}

type Column = "model" | "effort"

interface WheelColumnProps {
	spec: WheelColumnSpec
	align: "end" | "start"
	/** The column ←/→ and Tab land on (roving tab stop). */
	active: boolean
	columnRef: RefObject<HTMLDivElement>
	onFocus: () => void
	testId: string
	className?: string
}

/** Fades the rows away from the middle; the band behind the middle row stays solid (it is outside the mask). */
const FADE_MASK =
	"[mask-image:linear-gradient(to_bottom,transparent_0,black_32%,black_68%,transparent_100%)] [-webkit-mask-image:linear-gradient(to_bottom,transparent_0,black_32%,black_68%,transparent_100%)]"

function WheelColumn({ spec, align, active, columnRef, onFocus, testId, className }: WheelColumnProps) {
	const { items, index, disabled } = spec
	const specRef = useRef(spec)
	specRef.current = spec

	// Mouse wheel and trackpad scroll this column only: one row per notch, or per SCROLL_STEP px of a swipe.
	useEffect(() => {
		const column = columnRef.current
		if (!column) return
		let accumulated = 0
		const onWheel = (event: WheelEvent) => {
			event.preventDefault()
			const current = specRef.current
			if (current.disabled) return
			const delta = event.deltaMode === 1 ? event.deltaY * WHEEL_ROW_HEIGHT : event.deltaY
			accumulated += delta
			if (Math.abs(accumulated) >= SCROLL_STEP || Math.abs(delta) >= SCROLL_STEP) {
				const next = Math.max(0, Math.min(current.items.length - 1, current.index + (accumulated > 0 ? 1 : -1)))
				accumulated = 0
				if (next !== current.index) current.onSelect(next)
			}
		}
		column.addEventListener("wheel", onWheel, { passive: false })
		return () => column.removeEventListener("wheel", onWheel)
	}, [columnRef])

	return (
		<div
			aria-activedescendant={`${testId}-option-${index}`}
			aria-disabled={disabled || undefined}
			aria-label={spec.label}
			className={cn(
				"group/col relative min-w-0 overflow-hidden outline-none",
				FADE_MASK,
				disabled ? "cursor-not-allowed opacity-60" : "cursor-ns-resize",
				className,
			)}
			data-align={align}
			data-testid={testId}
			onFocus={onFocus}
			ref={columnRef}
			role="listbox"
			style={{ height: WHEEL_VISIBLE_ROWS * WHEEL_ROW_HEIGHT }}
			tabIndex={active ? 0 : -1}
			title={disabled ? spec.disabledReason : undefined}>
			<div
				className="transition-transform duration-150 ease-out motion-reduce:transition-none [.vscode-reduce-motion_&]:transition-none"
				data-testid={`${testId}-track`}
				style={{ transform: `translateY(${(MIDDLE_ROW - index) * WHEEL_ROW_HEIGHT}px)` }}>
				{items.map((item, i) => (
					<div
						aria-disabled={disabled || undefined}
						aria-selected={i === index}
						className={cn(
							"truncate whitespace-nowrap",
							align === "end" ? "pr-1 pl-2 text-right" : "pr-2 pl-1 text-left",
							i === index
								? "text-selection-foreground decoration-(--vscode-focusBorder) underline-offset-3 group-focus-visible/col:underline"
								: cn("text-description", !disabled && "cursor-pointer hover:text-foreground"),
						)}
						data-testid="wheel-option"
						id={`${testId}-option-${i}`}
						key={item.value}
						onClick={() => {
							if (!disabled && i !== index) spec.onSelect(i)
						}}
						role="option"
						style={{ height: WHEEL_ROW_HEIGHT, lineHeight: `${WHEEL_ROW_HEIGHT}px` }}
						title={item.detail ? `${item.label} · ${item.detail}` : undefined}>
						{item.label}
					</div>
				))}
			</div>
		</div>
	)
}

interface DoubleWheelProps {
	model: WheelColumnSpec
	/** The current model's efforts; undefined when it has no reasoning control (a lone "—"). */
	effort: WheelColumnSpec | undefined
	/** Enter or Space: keep the choice and close. */
	onEnter: () => void
	/** The column focus lands on when the menu opens. */
	wheelsRef?: RefObject<HTMLDivElement>
}

/**
 * Two wheels side by side: the model (right-aligned) and the effort (left-aligned) meet at a "+"
 * on the middle row, over a selection-colored band; whatever sits on the band is the choice. Each
 * column scrolls on its own (wheel, trackpad, a click on a row brings it to the middle); ↑/↓ move
 * the focused column, ←/→ switch columns, Home/End/PageUp/PageDown jump. One tab stop for both.
 */
export function DoubleWheel({ model, effort, onEnter, wheelsRef }: DoubleWheelProps) {
	const [active, setActive] = useState<Column>(model.disabled && effort && !effort.disabled ? "effort" : "model")
	const modelRef = useRef<HTMLDivElement>(null)
	const effortRef = useRef<HTMLDivElement>(null)
	const dash: WheelColumnSpec = {
		label: "Reasoning effort",
		items: [{ value: "none", label: "—" }],
		index: 0,
		onSelect: () => {},
		disabled: true,
		disabledReason: "This model has no reasoning control",
	}
	const effortSpec = effort ?? dash

	const focusColumn = (column: Column) => {
		setActive(column)
		;(column === "model" ? modelRef : effortRef).current?.focus()
	}

	const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
		const spec = active === "model" ? model : effortSpec
		const last = spec.items.length - 1
		const page = WHEEL_VISIBLE_ROWS - 1
		const targets: Record<string, number> = {
			ArrowUp: spec.index - 1,
			ArrowDown: spec.index + 1,
			PageUp: spec.index - page,
			PageDown: spec.index + page,
			Home: 0,
			End: last,
		}
		if (event.key in targets) {
			event.preventDefault()
			const next = Math.max(0, Math.min(last, targets[event.key]))
			if (!spec.disabled && next !== spec.index) spec.onSelect(next)
		} else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
			event.preventDefault()
			const column: Column = event.key === "ArrowLeft" ? "model" : "effort"
			if (column === "effort" && !effort) return
			focusColumn(column)
		} else if (event.key === "Enter" || event.key === " ") {
			event.preventDefault()
			onEnter()
		}
	}

	return (
		<div
			className="relative grid grid-cols-[minmax(0,1fr)_18px_auto] text-[12px]"
			data-testid="double-wheel"
			onKeyDown={onKeyDown}
			ref={wheelsRef}
			role="group">
			<div
				aria-hidden
				className="pointer-events-none absolute inset-x-0 rounded-xs bg-selection"
				data-testid="wheel-band"
				style={{ top: MIDDLE_ROW * WHEEL_ROW_HEIGHT, height: WHEEL_ROW_HEIGHT }}
			/>
			<WheelColumn
				active={active === "model"}
				align="end"
				columnRef={modelRef}
				onFocus={() => setActive("model")}
				spec={model}
				testId="model-wheel"
			/>
			<div
				aria-hidden
				className="relative flex items-center justify-center text-description"
				data-testid="wheel-joiner"
				style={{ height: WHEEL_VISIBLE_ROWS * WHEEL_ROW_HEIGHT }}>
				{effort ? "+" : ""}
			</div>
			<WheelColumn
				active={active === "effort"}
				align="start"
				className="min-w-[4.5rem]"
				columnRef={effortRef}
				onFocus={() => setActive("effort")}
				spec={effortSpec}
				testId="effort-wheel"
			/>
		</div>
	)
}
