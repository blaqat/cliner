import type { ReactElement, ReactNode } from "react"
import { useEffect, useRef, useState } from "react"
import { MENU_SEPARATOR_CLASS } from "@/components/common/menuStyles"
import type { SettingsNavigationTarget } from "@/components/settings/settingsTargets"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import { LIST_ROW_HEIGHT, type ListItem, ModelEffortLists } from "./ModelEffortLists"

/** One choice in the level list. */
export interface SelectorLevel {
	id: string
	label: string
	/** The row's tooltip ("Provider default"). */
	detail?: string
}

/** One choice in the model list: a configured model, or "Same as the thread". */
export interface SelectorRow {
	id: string
	label: string
	/** The row's tooltip (an upstream id, a connection). */
	detail?: string
	/** The connection or provider it sits under. With only one group, no heading shows. */
	group?: string
	/** The shorter name to use under that heading, when `label` repeats it. */
	groupedLabel?: string
	/** The levels it offers, or null when it has no level control (a lone "—"). */
	levels: SelectorLevel[] | null
	/** Why it has no level control: the "—"'s tooltip. */
	noLevelsReason?: string
	/** Say the reason under the lists too, with a link to the fix. */
	noLevelsNote?: string
	/** The level saved for a row without a level control. */
	noLevelId?: string
	/** The level this row brings when picked, unless one was picked by hand. */
	defaultLevelId?: string
	/** Why it can't be chosen (its connection has no key, say). A full sentence. */
	disabledReason?: string
	/** The control that fixes `disabledReason`, when the host names one. */
	fixTarget?: SettingsNavigationTarget
	/** The control that edits this row's levels. */
	levelsTarget?: SettingsNavigationTarget
}

export interface SelectorPick {
	rowId: string
	levelId: string
}

/** What the slots can read and do while the menu is open. */
export interface SelectorSlotContext {
	/** What the lists show right now. */
	pick: SelectorPick | null
	/** The lists differ from the saved pick. */
	moved: boolean
	/** Closes the menu, saving what the lists show or dropping it. */
	close: (keep: boolean) => void
}

export interface ModelSelectorProps {
	/** Every model, in display order. Add "Same as the thread" as a row for the roles that allow it. */
	rows: SelectorRow[]
	/**
	 * The level column, lowest first: levels the chosen row doesn't offer show greyed, with the reason.
	 * A level only the chosen row has ("Thread's level") goes on top while that row is chosen.
	 */
	ladder: SelectorLevel[]
	/** The saved pick; null when none is set. */
	pick: SelectorPick | null
	/** Enter, a click outside or Tab away, when the lists differ from `pick`. Escape never calls it. */
	onCommit: (pick: SelectorPick) => void
	/** The button that opens the menu. */
	trigger: ReactElement
	/** Names the model list; also the menu's accessible name unless `menuLabel` says otherwise. */
	modelsLabel: string
	menuLabel?: string
	/** The lists can't change right now, and why. */
	disabledReason?: string
	/** A line under the lists when nothing more urgent has to be said. */
	note?: string
	/** The note ends with this link to Settings › Models. */
	noteLink?: string
	/** Opens Settings › Models: the fix for an empty list or a model that can't run. */
	onManage: (target?: SettingsNavigationTarget) => void
	/** Above the lists (the composer's approval tiles). */
	top?: ReactNode
	/** Below the lists (the composer's Reset, Next message only, Models and default lines). */
	footer?: (context: SelectorSlotContext) => ReactNode
	align?: "start" | "center" | "end"
	side?: "top" | "bottom"
}

const NOTE_LINK_CLASS =
	"cursor-pointer border-0 bg-transparent p-0 text-[11px] text-link hover:text-link-hover focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-(--vscode-focusBorder)"

/** The lists never get less room than this while they have more to show: about four rows. */
const MIN_LISTS_HEIGHT = LIST_ROW_HEIGHT * 4

/**
 * Whether the lists can have their own scroll region in the height the window leaves. In a very short
 * window they can't: the top and bottom would squeeze them to nothing. Then the whole menu scrolls
 * instead, lists at full height. Either way, one scrollbar.
 */
const useMenuScrollsAsOne = (open: boolean, deps: unknown) => {
	// State, not a ref: the lists mount in the menu's portal after `open` flips, and measuring has to wait for them.
	const [lists, listsRef] = useState<HTMLDivElement | null>(null)
	const [asOne, setAsOne] = useState(false)

	useEffect(() => {
		const menu = lists?.parentElement
		if (!open || !lists || !menu) {
			setAsOne(false)
			return
		}
		const measure = () => {
			const style = window.getComputedStyle(menu)
			const available = Number.parseFloat(style.getPropertyValue("--radix-popover-content-available-height"))
			if (!Number.isFinite(available)) {
				return
			}
			const px = (value: string) => Number.parseFloat(value) || 0
			// Everything in the menu that takes up room and isn't the lists. The arrow is positioned, so it doesn't.
			const chrome = [...menu.children].reduce(
				(sum, child) => {
					const box = window.getComputedStyle(child)
					return child === lists || box.position === "absolute"
						? sum
						: sum + (child as HTMLElement).offsetHeight + px(box.marginTop) + px(box.marginBottom)
				},
				menu.offsetHeight - menu.clientHeight + px(style.paddingTop) + px(style.paddingBottom),
			)
			const needed = Math.min(MIN_LISTS_HEIGHT, lists.scrollHeight)
			setAsOne(available - chrome < needed)
		}
		measure()
		const frame = requestAnimationFrame(measure)
		window.addEventListener("resize", measure)
		const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure)
		observer?.observe(menu)
		return () => {
			cancelAnimationFrame(frame)
			window.removeEventListener("resize", measure)
			observer?.disconnect()
		}
	}, [open, lists, deps])

	return { listsRef, asOne }
}

/** What the lists show; nothing is saved until the menu closes with it kept. */
interface Draft {
	rowId: string | null
	levelId: string | null
	/** The level was picked by hand: a model change keeps it instead of taking that model's own. */
	levelTouched: boolean
	/** The model change had to move the level: says so until the next pick. */
	movedNote?: string
}

const findRow = (rows: SelectorRow[], id: string | null) => rows.find((row) => row.id === id)

/** The draft as a pick: a row without levels saves its fixed level, not the one carried across. */
function draftPick(draft: Draft, rows: SelectorRow[]): SelectorPick | null {
	if (draft.rowId === null) return null
	const row = findRow(rows, draft.rowId)
	const levelId = row?.levels ? draft.levelId : (row?.noLevelId ?? draft.levelId)
	return levelId === null ? null : { rowId: draft.rowId, levelId }
}

/**
 * The level a row lands on when picked: the one picked by hand, else its own, else what the lists
 * show now. If the row doesn't offer that one, the nearest level below it in `ladder`.
 */
function levelForRow(row: SelectorRow, draft: Draft, ladder: SelectorLevel[]): Pick<Draft, "levelId" | "movedNote"> {
	const wanted = draft.levelTouched ? draft.levelId : (row.defaultLevelId ?? draft.levelId)
	if (!row.levels) return { levelId: wanted }
	const offered = row.levels
	if (wanted !== null && offered.some((level) => level.id === wanted)) return { levelId: wanted }
	const rank = (id: string) => ladder.findIndex((level) => level.id === id)
	// Nothing to carry over (no pick yet, or "Thread's level"): the middle of what it offers.
	if (wanted === null || rank(wanted) < 0) {
		const middle = offered.find((level) => level.id === "medium") ?? offered[offered.length - 1]
		return { levelId: middle?.id ?? null }
	}
	const moved = [...offered].reverse().find((level) => rank(level.id) <= rank(wanted)) ?? offered[0]
	if (!moved) return { levelId: wanted }
	return {
		levelId: moved.id,
		movedNote: `Moved to ${moved.label}: ${row.label} doesn't offer ${ladder[rank(wanted)].label}.`,
	}
}

/**
 * The one model selector, for the composer and every model pick in Settings: a menu over two plain
 * lists (models | levels, the chosen rows banded) that stays inside the viewport with one scroll
 * region. Enter, a click outside or Tab away keep what the lists show; Escape puts the previous pick
 * back. Props-driven: it knows nothing about where the rows come from or how a pick is saved.
 */
export function ModelSelector({
	rows,
	ladder,
	pick,
	onCommit,
	trigger,
	modelsLabel,
	menuLabel,
	disabledReason,
	note,
	noteLink,
	onManage,
	top,
	footer,
	align = "end",
	side = "bottom",
}: ModelSelectorProps) {
	const [draft, setDraftState] = useState<Draft | null>(null)
	const draftRef = useRef<Draft | null>(null)
	const escapingRef = useRef(false)
	const listsRef = useRef<HTMLDivElement>(null)
	const open = draft !== null
	const { listsRef: scrollRef, asOne } = useMenuScrollsAsOne(open, draft?.rowId)

	const setDraft = (next: Draft | null) => {
		draftRef.current = next
		setDraftState(next)
	}

	const differs = (next: SelectorPick | null) => !!next && (next.rowId !== pick?.rowId || next.levelId !== pick?.levelId)

	const close = (keep: boolean) => {
		const current = draftRef.current
		if (!current) return
		const next = draftPick(current, rows)
		if (keep && next && differs(next)) onCommit(next)
		setDraft(null)
	}

	const openMenu = () => {
		escapingRef.current = false
		setDraft({ rowId: pick?.rowId ?? null, levelId: pick?.levelId ?? null, levelTouched: false })
	}

	const shown = draft ?? { rowId: pick?.rowId ?? null, levelId: pick?.levelId ?? null, levelTouched: false }
	const row = findRow(rows, shown.rowId)
	const grouped = new Set(rows.map((item) => item.group).filter(Boolean)).size > 1
	const modelItems: ListItem[] = rows.map((item) => ({
		value: item.id,
		label: (grouped && item.groupedLabel) || item.label,
		fullLabel: grouped && item.groupedLabel ? item.label : undefined,
		detail: item.detail,
		group: grouped ? item.group : undefined,
		disabledReason: item.disabledReason && `${item.disabledReason} Fix it in Settings › Models.`,
	}))

	const rowOnly = row?.levels?.filter((level) => !ladder.some((candidate) => candidate.id === level.id)) ?? []
	const levelItems: ListItem[] = [...rowOnly, ...ladder].map((level) => {
		const offered = row?.levels?.find((candidate) => candidate.id === level.id)
		return {
			value: level.id,
			label: offered?.label ?? level.label,
			detail: offered?.detail ?? level.detail,
			disabledReason: offered ? undefined : `${row?.label ?? "This model"} doesn't offer ${level.label}`,
		}
	})
	// A saved level this model doesn't offer stays on show, marked, until it's changed.
	if (row?.levels && shown.levelId && !levelItems.some((item) => item.value === shown.levelId)) {
		levelItems.push({
			value: shown.levelId,
			label: shown.levelId,
			disabledReason: `${row.label} doesn't offer ${shown.levelId}`,
		})
	}
	const levelIndex = levelItems.findIndex((item) => item.value === shown.levelId)
	const badLevel = row?.levels && levelIndex >= 0 ? levelItems[levelIndex].disabledReason : undefined

	const fixLink = (label: string, target?: SettingsNavigationTarget) => (
		<button
			className={NOTE_LINK_CLASS}
			data-testid="model-menu-fix"
			onClick={() => {
				close(true)
				onManage(target)
			}}
			type="button">
			{label}
		</button>
	)

	const currentNote: ReactNode = disabledReason ? (
		<>
			<span aria-hidden className="codicon codicon-lock text-[11px]!" />
			{disabledReason}
		</>
	) : shown.movedNote ? (
		shown.movedNote
	) : badLevel ? (
		<span>
			{badLevel}, so this pick won't start. Pick a level or {fixLink("edit the model", row?.levelsTarget)}
		</span>
	) : row?.disabledReason ? (
		<span>
			{row.disabledReason} {fixLink("Fix it in Settings › Models", row.fixTarget)}
		</span>
	) : row?.noLevelsNote ? (
		<span>
			{row.noLevelsNote} {fixLink("Set it")}
		</span>
	) : note ? (
		<span>
			{note} {noteLink && fixLink(noteLink)}
		</span>
	) : null

	const current = draft ? draftPick(draft, rows) : pick
	const context: SelectorSlotContext = { pick: current, moved: !!draft && differs(current), close }

	return (
		<Popover onOpenChange={(next) => (next ? openMenu() : close(!escapingRef.current))} open={open}>
			<PopoverTrigger asChild>{trigger}</PopoverTrigger>
			<PopoverContent
				align={align}
				aria-label={menuLabel ?? modelsLabel}
				className={cn(
					"menu-rise flex max-h-(--radix-popover-content-available-height) w-[260px] max-w-[calc(100vw-8px)] flex-col overscroll-contain p-1.5 text-xs",
					asOne ? "overflow-y-auto" : "overflow-hidden",
				)}
				collisionPadding={4}
				data-menu-scroll={asOne ? "whole" : "lists"}
				data-testid="model-menu"
				onEscapeKeyDown={() => {
					escapingRef.current = true
				}}
				onOpenAutoFocus={(event) => {
					// Focus lands on the lists (the column with the tab stop), not the first button.
					const column = listsRef.current?.querySelector<HTMLElement>('[role="listbox"][tabindex="0"]')
					if (!column) return
					event.preventDefault()
					column.focus({ preventScroll: true })
				}}
				role="dialog"
				side={side}
				sideOffset={6}>
				{top && (
					<>
						<div className="shrink-0">{top}</div>
						<hr className={cn(MENU_SEPARATOR_CLASS, "shrink-0")} />
					</>
				)}
				{rows.length === 0 ? (
					// A note says why there's nothing better than this line would.
					!note && (
						<p className="m-0 shrink-0 px-1 py-1 text-[11px] text-description" data-testid="model-menu-empty">
							No models set up yet. {fixLink("Add one in Settings › Models")}
						</p>
					)
				) : (
					// The one scroll region: a long model list scrolls here, both columns together, unless the window is too short for that.
					<div
						className={asOne ? "shrink-0" : "min-h-0 shrink overflow-y-auto overscroll-contain"}
						data-testid="model-menu-scroll"
						ref={scrollRef}>
						<ModelEffortLists
							effort={
								row?.levels
									? {
											label: "Reasoning effort",
											items: levelItems,
											index: levelIndex,
											onSelect: (index) => {
												const currentDraft = draftRef.current
												const levelId = levelItems[index]?.value
												if (currentDraft && levelId)
													setDraft({
														...currentDraft,
														levelId,
														levelTouched: true,
														movedNote: undefined,
													})
											},
											disabled: !!disabledReason,
											disabledReason,
										}
									: undefined
							}
							listsRef={listsRef}
							model={{
								label: modelsLabel,
								items: modelItems,
								index: rows.findIndex((item) => item.id === shown.rowId),
								onSelect: (index) => {
									const currentDraft = draftRef.current
									const nextRow = rows[index]
									if (!currentDraft || !nextRow) return
									setDraft({
										...currentDraft,
										rowId: nextRow.id,
										movedNote: undefined,
										...levelForRow(nextRow, currentDraft, ladder),
									})
								},
								disabled: !!disabledReason,
								disabledReason,
							}}
							noEffortReason={row ? row.noLevelsReason : "Pick a model first"}
							onEnter={() => close(true)}
						/>
					</div>
				)}
				{currentNote && (
					<p
						className="m-0 flex shrink-0 items-center gap-1 px-1 pt-1 text-[11px] text-description"
						data-testid="model-menu-note">
						{currentNote}
					</p>
				)}
				{footer?.(context)}
			</PopoverContent>
		</Popover>
	)
}
