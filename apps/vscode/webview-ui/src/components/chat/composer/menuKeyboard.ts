import type React from "react"

const ITEM_SELECTOR = '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]'

function menuItems(menu: HTMLElement): HTMLElement[] {
	return [...menu.querySelectorAll<HTMLElement>(ITEM_SELECTOR)].filter(
		(item) => !item.hasAttribute("disabled") && item.getAttribute("aria-disabled") !== "true",
	)
}

/**
 * Arrow keys, Home and End move focus between the composer menus' items (Escape is the popover's).
 * Typing in a field inside the menu keeps its own Home/End; ArrowDown from the field enters the list.
 */
export function handleMenuKeyDown(event: React.KeyboardEvent<HTMLElement>) {
	const { key } = event
	if (key !== "ArrowDown" && key !== "ArrowUp" && key !== "Home" && key !== "End") {
		return
	}
	const target = event.target as HTMLElement
	const inField = target.tagName === "INPUT" || target.tagName === "TEXTAREA"
	if (inField && key !== "ArrowDown") {
		return
	}
	const items = menuItems(event.currentTarget)
	if (items.length === 0) {
		return
	}
	event.preventDefault()
	const index = items.indexOf(target)
	const next =
		key === "Home"
			? 0
			: key === "End"
				? items.length - 1
				: index === -1
					? key === "ArrowDown"
						? 0
						: items.length - 1
					: (index + (key === "ArrowDown" ? 1 : -1) + items.length) % items.length
	items[next]?.focus()
}

/** Shared row and heading styles for the composer's menus (the same as every other popover menu). */
export { MENU_HEADING_CLASS, MENU_ITEM_CLASS as MENU_ROW_CLASS } from "@/components/common/menuStyles"
