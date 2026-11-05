import type { CSSProperties } from "react"

/**
 * One geometry for every task → thread list (the classic home inbox, one view's list and the task
 * page's timeline), so the connector line can't drift off the icons again.
 *
 * A row is `border` (1px) + {@link ROW_PAD_X_PX} padding, then a {@link ICON_COL_PX} icon column:
 * the column's center sits at {@link ICON_CENTER_X_PX} from the row's left edge. The connector is
 * {@link SPINE_WIDTH_PX} wide on whole pixels around that center, so it stays exactly centered and
 * crisp at any zoom.
 */
export const ROW_BORDER_PX = 1
export const ROW_PAD_X_PX = 8
export const ICON_COL_PX = 14
export const ICON_CENTER_X_PX = ROW_BORDER_PX + ROW_PAD_X_PX + ICON_COL_PX / 2
export const SPINE_WIDTH_PX = 2
export const SPINE_LEFT_PX = ICON_CENTER_X_PX - SPINE_WIDTH_PX / 2

/** How far a task's threads sit right of the task row: their rows start just past the connector. */
export const MEMBER_INDENT_PX = 20

/** The task row icon's vertical center, from the top of the task block (the row's title line). */
export const TASK_ICON_CENTER_Y_PX = 14
/** Half the task icon's height plus a small gap: where the connector starts below the icon's center. */
export const SPINE_START_BELOW_ICON_PX = 6 + 3

/** The connector's color and shape (the task page timeline uses the same). */
export const SPINE_CLASS = "pointer-events-none absolute rounded-full bg-description/30"

/** Grid columns and side padding for a row whose first column is the icon column. */
export function treeRowStyle(rest = "minmax(0,1fr) auto"): CSSProperties {
	return {
		gridTemplateColumns: `${ICON_COL_PX}px ${rest}`,
		paddingLeft: ROW_PAD_X_PX,
		paddingRight: ROW_PAD_X_PX,
	}
}

/**
 * The connector of an expanded task, positioned in the task block (row + threads): from just below
 * the task's icon down past its threads, through the icon column's center.
 */
export const TASK_SPINE_STYLE: CSSProperties = {
	left: SPINE_LEFT_PX,
	width: SPINE_WIDTH_PX,
	top: TASK_ICON_CENTER_Y_PX + SPINE_START_BELOW_ICON_PX,
	bottom: 6,
}
