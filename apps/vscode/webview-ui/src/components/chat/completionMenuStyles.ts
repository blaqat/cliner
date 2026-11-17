/**
 * The look of the composer's slash command menu, shared by the `#` note and `thread:` menus so all
 * three completion lists match.
 */
export const COMPLETION_MENU_CLASS =
	"bg-(--vscode-dropdown-background) border border-(--vscode-editorGroup-border) rounded-[3px] shadow-[0_4px_10px_var(--vscode-widget-shadow)] flex flex-col overflow-y-auto"

export const COMPLETION_SECTION_CLASS =
	"text-xs text-(--vscode-descriptionForeground) px-3 py-1 font-bold border-b border-(--vscode-editorGroup-border)"

export function completionItemClass(selected: boolean): string {
	return `py-2 px-3 cursor-pointer flex flex-col border-b border-(--vscode-editorGroup-border) ${
		selected ? "bg-(--vscode-quickInputList-focusBackground) text-(--vscode-quickInputList-focusForeground)" : ""
	} hover:bg-(--vscode-list-hoverBackground)`
}

export function completionDetailClass(selected: boolean): string {
	return `text-[0.85em] truncate ${
		selected ? "text-(--vscode-quickInputList-focusForeground)" : "text-(--vscode-descriptionForeground)"
	}`
}
