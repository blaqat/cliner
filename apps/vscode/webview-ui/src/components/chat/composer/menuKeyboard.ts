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

/** Shared row style for the composer's menus. */
export const MENU_ROW_CLASS =
	"flex h-6 w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-xs border-0 bg-transparent px-2 text-left text-xs text-menu-foreground hover:bg-list-hover focus-visible:bg-list-hover focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"

export const MENU_HEADING_CLASS = "px-2 pt-1 pb-0.5 text-[10px] font-medium uppercase tracking-wider text-description"
