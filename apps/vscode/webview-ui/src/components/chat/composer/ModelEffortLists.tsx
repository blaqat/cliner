import type React from "react"
import { type RefObject, useEffect, useRef, useState } from "react"
import { cn } from "@/lib/utils"

/** One list row (px). */
export const LIST_ROW_HEIGHT = 22

export interface ListItem {
	value: string
	label: string
	/** More about the choice (a model id, "Provider default"): the row's tooltip. */
	detail?: string
}

export interface ListColumnSpec {
	label: string
	items: ListItem[]
	index: number
	onSelect: (index: number) => void
	/** Can't change (a locked choice, or a model without reasoning): shown, but inert. */
	disabled?: boolean
	/** Why it can't change. */
	disabledReason?: string
}

type Column = "model" | "effort"

interface ListColumnProps {
	spec: ListColumnSpec
	align: "end" | "start"
	/** The column ←/→ and Tab land on (roving tab stop). */
	active: boolean
	columnRef: RefObject<HTMLDivElement>
	onFocus: () => void
	testId: string
	className?: string
}

function ListColumn({ spec, align, active, columnRef, onFocus, testId, className }: ListColumnProps) {
	const { items, index, disabled } = spec

	// A long model list scrolls the lists' region; keep the chosen row in view as the keys move it.
	useEffect(() => {
		columnRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView?.({ block: "nearest" })
	}, [columnRef, index])

	return (
		<div
			aria-activedescendant={`${testId}-option-${index}`}
			aria-disabled={disabled || undefined}
			aria-label={spec.label}
			className={cn(
				"group/col flex min-w-0 flex-col gap-px outline-none",
				disabled && "cursor-not-allowed opacity-60",
				className,
			)}
			data-align={align}
			data-testid={testId}
			onFocus={onFocus}
			ref={columnRef}
			role="listbox"
			tabIndex={active ? 0 : -1}
			title={disabled ? spec.disabledReason : undefined}>
			{items.map((item, i) => (
				<div
					aria-disabled={disabled || undefined}
					aria-selected={i === index}
					className={cn(
						"shrink-0 truncate whitespace-nowrap rounded-xs",
						align === "end" ? "pr-1.5 pl-2 text-right" : "pr-2 pl-1.5 text-left",
						i === index
							? "bg-selection text-selection-foreground decoration-(--vscode-focusBorder) underline-offset-3 group-focus-visible/col:underline"
							: cn("text-description", !disabled && "cursor-pointer hover:bg-list-hover hover:text-foreground"),
					)}
					data-testid="list-option"
					id={`${testId}-option-${i}`}
					key={item.value}
					onClick={() => {
						if (!disabled && i !== index) spec.onSelect(i)
					}}
					role="option"
					style={{ height: LIST_ROW_HEIGHT, lineHeight: `${LIST_ROW_HEIGHT}px` }}
					title={item.detail ? `${item.label} · ${item.detail}` : undefined}>
					{item.label}
				</div>
			))}
		</div>
	)
}

interface ModelEffortListsProps {
	model: ListColumnSpec
	/** The current model's efforts; undefined when it has no reasoning control (a lone "—"). */
	effort: ListColumnSpec | undefined
	/** Enter or Space: keep the choice and close. */
	onEnter: () => void
	/** The column focus lands on when the menu opens. */
	listsRef?: RefObject<HTMLDivElement>
	className?: string
}

/**
 * Two plain lists side by side, every option on show: the saved models (right-aligned) and the
 * efforts (left-aligned) meet in the middle. The chosen row in each has the selection band. A click
 * picks a row; ↑/↓ move the focused column's choice, ←/→ switch columns, Home/End/PageUp/PageDown
 * jump, Enter or Space keep it. One tab stop for both. Both columns sit in one scroll region, so a
 * long model list scrolls them together.
 */
export function ModelEffortLists({ model, effort, onEnter, listsRef, className }: ModelEffortListsProps) {
	const [active, setActive] = useState<Column>(model.disabled && effort && !effort.disabled ? "effort" : "model")
	const modelRef = useRef<HTMLDivElement>(null)
	const effortRef = useRef<HTMLDivElement>(null)
	const dash: ListColumnSpec = {
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
		const page = 4
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
			className={cn("grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-1.5 text-[12px]", className)}
			data-testid="model-effort-lists"
			onKeyDown={onKeyDown}
			ref={listsRef}
			role="group">
			<ListColumn
				active={active === "model"}
				align="end"
				columnRef={modelRef}
				onFocus={() => setActive("model")}
				spec={model}
				testId="model-list"
			/>
			<ListColumn
				active={active === "effort"}
				align="start"
				className="min-w-[4.5rem] border-0 border-l border-solid border-menu-foreground/10 pl-1.5"
				columnRef={effortRef}
				onFocus={() => setActive("effort")}
				spec={effortSpec}
				testId="effort-list"
			/>
		</div>
	)
}
