import { within } from "@testing-library/react"
import { expect } from "vitest"
import {
	ICON_CENTER_X_PX,
	ICON_COL_PX,
	MEMBER_INDENT_PX,
	ROW_BORDER_PX,
	ROW_PAD_X_PX,
	SPINE_LEFT_PX,
	SPINE_WIDTH_PX,
} from "./treeGeometry"

/** The row puts its icon column where the geometry says: 1px border, the padding, then the column. */
function expectIconColumn(row: HTMLElement) {
	expect(row).toHaveClass("border")
	expect(row.style.gridTemplateColumns.startsWith(`${ICON_COL_PX}px `)).toBe(true)
	expect(row.style.paddingLeft).toBe(`${ROW_PAD_X_PX}px`)
}

/**
 * An expanded task block (jsdom has no layout, so this pins the inline geometry): the connector's
 * center is the task row's icon column center, and its threads start past the connector with the
 * same row geometry.
 */
export function expectCenteredSpine(block: HTMLElement, rowTestId: string, memberTestId: string) {
	expect(ICON_CENTER_X_PX).toBe(ROW_BORDER_PX + ROW_PAD_X_PX + ICON_COL_PX / 2)
	expectIconColumn(within(block).getByTestId(rowTestId))
	const spine = within(block).getByTestId("task-spine")
	expect(spine.style.left).toBe(`${SPINE_LEFT_PX}px`)
	expect(spine.style.width).toBe(`${SPINE_WIDTH_PX}px`)
	expect(SPINE_LEFT_PX + SPINE_WIDTH_PX / 2).toBe(ICON_CENTER_X_PX)
	// Whole pixels: crisp, and exactly centered.
	expect(Number.isInteger(SPINE_LEFT_PX)).toBe(true)
	const members = within(block).getAllByTestId(memberTestId)
	expect(members.length).toBeGreaterThan(0)
	for (const member of members) {
		expectIconColumn(member)
		expect(member.parentElement?.style.paddingLeft).toBe(`${MEMBER_INDENT_PX}px`)
	}
	expect(MEMBER_INDENT_PX).toBeGreaterThan(SPINE_LEFT_PX + SPINE_WIDTH_PX)
}
