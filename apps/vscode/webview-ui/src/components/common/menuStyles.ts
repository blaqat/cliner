/**
 * One look for every popover menu (header ⋯, Back history, composer pills and ＋, walkthrough):
 * 24px rows, codicon + label, the list hover color, and the focus ring VS Code menus use.
 */
export const MENU_ITEM_CLASS =
	"flex h-6 w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-xs border-0 bg-transparent px-2 text-left text-[12px] text-menu-foreground hover:bg-list-hover focus-visible:bg-list-hover focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-(--vscode-focusBorder) disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"

/** Small uppercase group label inside a menu ("Recent", "Workspace"). */
export const MENU_HEADING_CLASS = "px-2 pt-1 pb-0.5 text-[10px] font-medium uppercase tracking-wider text-description"

/** Divider between groups of menu rows. */
export const MENU_SEPARATOR_CLASS = "my-1 h-px border-0 bg-menu-foreground/10"

/** Leading codicon in a menu row. */
export const MENU_ICON_CLASS = "codicon shrink-0 text-[13px]!"

/**
 * Icon-only trigger in the composer's bottom row (＋, MCP servers, rules): 20px square, toolbar
 * hover, focus ring; pair it with `COMPOSER_ICON_BUTTON_OPEN_CLASS` while its popover is open.
 */
export const COMPOSER_ICON_BUTTON_CLASS =
	"flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-xs border-0 bg-transparent p-0 text-description hover:bg-toolbar-hover hover:text-foreground focus-visible:outline focus-visible:outline-1 focus-visible:outline-(--vscode-focusBorder)"

export const COMPOSER_ICON_BUTTON_OPEN_CLASS = "bg-toolbar-hover text-foreground"
