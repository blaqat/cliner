import type React from "react"
import { Fragment, type RefObject, useEffect, useId, useRef, useState } from "react"
import { cn } from "@/lib/utils"

/** One list row (px). */
export const LIST_ROW_HEIGHT = 22

export interface ListItem {
	value: string
	label: string
	/** More about the choice (a model id, "Provider default"): the row's tooltip. */
	detail?: string
	/** The heading this row sits under; a row with the same group as the last one adds no heading. */
	group?: string
	/** The full name, when `label` leans on the heading to tell two rows apart. */
	fullLabel?: string
	/** Why this row can't be chosen: greyed, skipped by the keys, the reason in its tooltip. */
	disabledReason?: string
}

export interface ListColumnSpec {
	label: string
	items: ListItem[]
	/** -1: nothing chosen yet. */
	index: number
	onSelect: (index: number) => void
	/** Can't change (a locked choice, or a model without reasoning): shown, but inert. */
	disabled?: boolean
	/** Why it can't change. */
	disabledReason?: string
}

type Column = "model" | "effort"

/** The enabled row nearest `target`, looking in `step`'s direction first; -1 when there is none. */
function enabledRow(items: ListItem[], target: number, step: 1 | -1): number {
	const start = Math.max(0, Math.min(items.length - 1, target))
	for (const direction of [step, -step]) {
		for (let i = start; i >= 0 && i < items.length; i += direction) {
			if (!items[i].disabledReason) return i
		}
	}
	return -1
}

interface ListColumnProps {
	spec: ListColumnSpec
	align: "end" | "start"
	/** The column ←/→ and Tab land on (roving tab stop). */
	active: boolean
	columnRef: RefObject<HTMLDivElement>
	onFocus: () => void
	onRowClick: () => void
	testId: string
	className?: string
}

function ListColumn({ spec, align, active, columnRef, onFocus, onRowClick, testId, className }: ListColumnProps) {
	const { items, index, disabled } = spec
	const baseId = useId()

	// A long model list scrolls the lists' region; keep the chosen row in view as the keys move it.
	useEffect(() => {
		columnRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView?.({ block: "nearest" })
	}, [columnRef, index])

	return (
		<div
			aria-activedescendant={index >= 0 ? `${baseId}-option-${index}` : undefined}
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
			{items.map((item, i) => {
				const off = !!item.disabledReason
				const heading = item.group && item.group !== items[i - 1]?.group ? item.group : undefined
				return (
					<Fragment key={item.value}>
						{heading && (
							<div
								className={cn(
									"shrink-0 truncate whitespace-nowrap px-1.5 pt-1 pb-0.5 text-[10px] font-medium uppercase tracking-wider text-description",
									align === "end" ? "text-right" : "text-left",
								)}
								data-testid="list-group"
								role="presentation">
								{heading}
							</div>
						)}
						<div
							aria-disabled={disabled || off || undefined}
							aria-label={item.fullLabel}
							aria-selected={i === index}
							className={cn(
								"shrink-0 truncate whitespace-nowrap rounded-xs",
								align === "end" ? "pr-1.5 pl-2 text-right" : "pr-2 pl-1.5 text-left",
								i === index && off
									? "cursor-not-allowed bg-warning/15 text-warning"
									: i === index
										? "bg-selection text-selection-foreground decoration-(--vscode-focusBorder) underline-offset-3 group-focus-visible/col:underline"
										: off
											? "cursor-not-allowed text-description opacity-50"
											: cn(
													"text-description",
													!disabled && "cursor-pointer hover:bg-list-hover hover:text-foreground",
												),
							)}
							data-testid="list-option"
							id={`${baseId}-option-${i}`}
							onClick={() => {
								if (disabled || off) return
								if (i !== index) spec.onSelect(i)
								onRowClick()
							}}
							role="option"
							style={{ height: LIST_ROW_HEIGHT, lineHeight: `${LIST_ROW_HEIGHT}px` }}
							title={item.disabledReason ?? (item.detail ? `${item.label} · ${item.detail}` : undefined)}>
							{item.label}
						</div>
					</Fragment>
				)
			})}
		</div>
	)
}

interface ModelEffortListsProps {
	model: ListColumnSpec
	/** The current model's efforts; undefined when it has no reasoning control (a lone "—"). */
	effort: ListColumnSpec | undefined
	/** Why the lone "—" is there. */
	noEffortReason?: string
	/** Enter or Space: keep the choice and close. */
	onEnter: () => void
	/** A row was clicked, after its column's `onSelect`: keep the choice and stay open for the other list. */
	onRowClick: () => void
	/** The column focus lands on when the menu opens. */
	listsRef?: RefObject<HTMLDivElement>
	className?: string
}

/**
 * Two plain lists side by side, every option on show: the models (right-aligned) and the efforts
 * (left-aligned) meet in the middle. The chosen row in each has the selection band. A click picks a
 * row and keeps it; ↑/↓ move the focused column's choice, ←/→ switch columns, Home/End/PageUp/PageDown
 * jump, Enter or Space keep it. The keys step over rows that can't be chosen. One tab stop for both.
 * Both columns sit in one scroll region, so a long model list scrolls them together.
 */
export function ModelEffortLists({
	model,
	effort,
	noEffortReason = "This model has no reasoning control",
	onEnter,
	onRowClick,
	listsRef,
	className,
}: ModelEffortListsProps) {
	const [active, setActive] = useState<Column>(model.disabled && effort && !effort.disabled ? "effort" : "model")
	const modelRef = useRef<HTMLDivElement>(null)
	const effortRef = useRef<HTMLDivElement>(null)
	const dash: ListColumnSpec = {
		label: "Reasoning effort",
		items: [{ value: "none", label: "—" }],
		index: 0,
		onSelect: () => {},
		disabled: true,
		disabledReason: noEffortReason,
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
		const targets: Record<string, [number, 1 | -1]> = {
			ArrowUp: [spec.index - 1, -1],
			ArrowDown: [spec.index + 1, 1],
			PageUp: [spec.index - page, -1],
			PageDown: [spec.index + page, 1],
			Home: [0, 1],
			End: [last, -1],
		}
		if (event.key in targets) {
			event.preventDefault()
			const next = enabledRow(spec.items, ...targets[event.key])
			if (!spec.disabled && next >= 0 && next !== spec.index) spec.onSelect(next)
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
				onRowClick={onRowClick}
				spec={model}
				testId="model-list"
			/>
			<ListColumn
				active={active === "effort"}
				align="start"
				className="min-w-[4.5rem] border-0 border-l border-solid border-menu-foreground/10 pl-1.5"
				columnRef={effortRef}
				onFocus={() => setActive("effort")}
				onRowClick={onRowClick}
				spec={effortSpec}
				testId="effort-list"
			/>
		</div>
	)
}
