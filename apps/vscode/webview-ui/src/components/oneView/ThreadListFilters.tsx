import { cn } from "@/lib/utils"
import {
	countFilters,
	DATE_CHIPS,
	type DateFilter,
	isDateActive,
	KIND_CHIPS,
	type KindChip,
	type ListFilter,
	NO_FILTER,
	STATE_CHIPS,
	type StateChip,
} from "./threadListModel"

export const CHIP_CLASS =
	"flex h-5 min-w-0 cursor-pointer items-center gap-1 rounded-full border px-2 text-[11px] focus-visible:outline focus-visible:outline-1 focus-visible:outline-(--vscode-focusBorder)"
export const CHIP_ON =
	"border-(--vscode-focusBorder) bg-(--vscode-list-activeSelectionBackground) text-(--vscode-list-activeSelectionForeground)"
export const CHIP_OFF = "border-editor-group-border bg-transparent text-foreground hover:bg-list-hover"
const LINK_CLASS = "cursor-pointer border-0 bg-transparent p-0 text-[11px] text-link hover:text-link-hover"
const LABEL_CLASS = "flex h-5 items-center text-[10px] font-medium uppercase tracking-wider text-description"
const DATE_INPUT_CLASS =
	"h-5 min-w-0 rounded-xs border border-editor-group-border bg-input-background px-1 text-[11px] text-input-foreground outline-none focus:border-(--vscode-focusBorder)"

const toggled = <T,>(set: ReadonlySet<T>, value: T): Set<T> => {
	const next = new Set(set)
	if (!next.delete(value)) next.add(value)
	return next
}

/** "Mar 3" for a custom bound. */
function formatDay(value: string): string {
	const [year, month, day] = value.split("-").map(Number)
	return new Date(year, month - 1, day).toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

/** The date chip's label, with a custom range spelled out ("Mar 3 – Mar 9", "Since Mar 3"). */
export function dateLabel(date: DateFilter): string {
	if (date.range !== "custom") return DATE_CHIPS.find((chip) => chip.id === date.range)?.label ?? ""
	if (date.from && date.to) return `${formatDay(date.from)} – ${formatDay(date.to)}`
	if (date.from) return `Since ${formatDay(date.from)}`
	if (date.to) return `Until ${formatDay(date.to)}`
	return "Custom"
}

interface FilterPanelProps {
	filter: ListFilter
	onChange: (filter: ListFilter) => void
	/** Resets the panel and drops `#tag` tokens from the field. */
	onClear: () => void
	/** Something is narrowing the list (panel chips or typed `#tags`). */
	canClear: boolean
}

/**
 * The filter panel under the search field: what to search in, state chips and a last-activity
 * window. Works with or without search text.
 */
export const FilterPanel = ({ filter, onChange, onClear, canClear }: FilterPanelProps) => {
	const chip = (label: string, on: boolean, onClick: () => void, title?: string) => (
		<button
			aria-pressed={on}
			className={cn(CHIP_CLASS, on ? CHIP_ON : CHIP_OFF)}
			key={label}
			onClick={onClick}
			title={title}
			type="button">
			<span className="truncate">{label}</span>
		</button>
	)

	const setDate = (date: DateFilter) => onChange({ ...filter, date })

	return (
		<div className="flex flex-col gap-1.5 px-1 pt-0.5 pb-2" data-testid="one-view-filter-chips">
			<div className="flex flex-wrap gap-1">
				{KIND_CHIPS.map((kind) =>
					chip(
						kind.label,
						filter.kinds.has(kind.id),
						() => onChange({ ...filter, kinds: toggled(filter.kinds, kind.id) }),
						kind.title,
					),
				)}
			</div>
			<div className="flex flex-wrap gap-1">
				{STATE_CHIPS.map((state) =>
					chip(state.label, filter.states.has(state.id), () =>
						onChange({ ...filter, states: toggled(filter.states, state.id) }),
					),
				)}
			</div>
			<div
				aria-label="Last activity"
				className="flex flex-wrap items-center gap-1"
				data-testid="one-view-filter-date"
				role="group">
				<span className={cn(LABEL_CLASS, "mr-0.5")} title="Last activity">
					Date
				</span>
				{DATE_CHIPS.map((date) =>
					chip(date.label, filter.date.range === date.id, () =>
						setDate(
							date.id === "custom"
								? { range: "custom", from: filter.date.from, to: filter.date.to }
								: { range: date.id },
						),
					),
				)}
				{filter.date.range === "custom" && (
					<div className="flex min-w-0 items-center gap-1 text-[11px] text-description">
						<input
							aria-label="From"
							className={DATE_INPUT_CLASS}
							data-testid="one-view-date-from"
							max={filter.date.to || undefined}
							onChange={(event) => setDate({ ...filter.date, from: event.target.value || undefined })}
							type="date"
							value={filter.date.from ?? ""}
						/>
						<span aria-hidden>–</span>
						<input
							aria-label="To"
							className={DATE_INPUT_CLASS}
							data-testid="one-view-date-to"
							min={filter.date.from || undefined}
							onChange={(event) => setDate({ ...filter.date, to: event.target.value || undefined })}
							type="date"
							value={filter.date.to ?? ""}
						/>
					</div>
				)}
			</div>
			{canClear && (
				<div className="flex justify-end">
					<button className={LINK_CLASS} data-testid="one-view-clear-filters" onClick={onClear} type="button">
						Clear filters
					</button>
				</div>
			)}
		</div>
	)
}

interface ActiveFiltersProps {
	filter: ListFilter
	onChange: (filter: ListFilter) => void
	onClear: () => void
}

/** With the panel closed: the filters that are on, each removable, so missing rows are never a mystery. */
export const ActiveFilters = ({ filter, onChange, onClear }: ActiveFiltersProps) => {
	if (countFilters(filter) === 0) return null
	const remove = (key: string, label: string, onRemove: () => void, icon?: string) => (
		<button
			aria-label={`Remove filter ${label}`}
			className={cn(CHIP_CLASS, CHIP_ON, "max-w-40 pr-1.5")}
			key={key}
			onClick={onRemove}
			title={`Remove filter: ${label}`}
			type="button">
			{icon && <span aria-hidden className={`codicon codicon-${icon} shrink-0 text-[10px]!`} />}
			<span className="truncate">{label}</span>
			<span aria-hidden className="codicon codicon-close shrink-0 text-[10px]!" />
		</button>
	)
	const kindLabel = (id: KindChip) => KIND_CHIPS.find((chip) => chip.id === id)?.label ?? id
	const stateLabel = (id: StateChip) => STATE_CHIPS.find((chip) => chip.id === id)?.label ?? id
	return (
		<div className="flex shrink-0 flex-wrap items-center gap-1 px-2 pb-1.5" data-testid="one-view-active-filters">
			{[...filter.kinds].map((id) =>
				remove(`kind:${id}`, kindLabel(id), () => onChange({ ...filter, kinds: toggled(filter.kinds, id) })),
			)}
			{[...filter.states].map((id) =>
				remove(`state:${id}`, stateLabel(id), () => onChange({ ...filter, states: toggled(filter.states, id) })),
			)}
			{isDateActive(filter.date) &&
				remove("date", dateLabel(filter.date), () => onChange({ ...filter, date: NO_FILTER.date }), "calendar")}
			<button className={cn(LINK_CLASS, "ml-0.5")} onClick={onClear} type="button">
				Clear
			</button>
		</div>
	)
}
