import { useEffect, useRef } from "react"
import type { NoteMentionOption } from "./noteMentions"

interface NoteMentionMenuProps {
	notes: NoteMentionOption[]
	selectedIndex: number
	setSelectedIndex: (index: number) => void
	onSelect: (note: NoteMentionOption) => void
}

/**
 * `#` completion list of notebook notes across every task. The composer's own
 * task's notes come first under "This task"; the rest follow under "Other
 * tasks" and show the owning task's name. Same look as the slash command menu.
 */
const NoteMentionMenu = ({ notes, selectedIndex, setSelectedIndex, onSelect }: NoteMentionMenuProps) => {
	const menuRef = useRef<HTMLDivElement>(null)

	useEffect(() => {
		const menu = menuRef.current
		const selected = menu?.querySelector<HTMLElement>(`#note-mention-menu-item-${selectedIndex}`)
		if (!menu || !selected) return
		const menuRect = menu.getBoundingClientRect()
		const selectedRect = selected.getBoundingClientRect()
		if (selectedRect.bottom > menuRect.bottom) {
			menu.scrollTop += selectedRect.bottom - menuRect.bottom
		} else if (selectedRect.top < menuRect.top) {
			menu.scrollTop -= menuRect.top - selectedRect.top
		}
	}, [selectedIndex])

	const sectionClass =
		"text-xs text-(--vscode-descriptionForeground) px-3 py-1 font-bold border-b border-(--vscode-editorGroup-border)"
	const ownTaskTitle = notes.find((n) => n.isCurrentTask)?.taskGroupTitle
	let sawOwn = false
	let sawOther = false
	const rows: React.ReactNode[] = []
	notes.forEach((note, index) => {
		if (note.isCurrentTask && !sawOwn) {
			sawOwn = true
			rows.push(
				<div className={sectionClass} key="section-own" role="presentation">
					This task{ownTaskTitle ? ` · ${ownTaskTitle}` : ""}
				</div>,
			)
		} else if (!note.isCurrentTask && !sawOther) {
			sawOther = true
			rows.push(
				<div className={sectionClass} key="section-other" role="presentation">
					Other tasks
				</div>,
			)
		}
		const item = (
			<div
				aria-selected={index === selectedIndex}
				className={`py-1.5 px-3 cursor-pointer flex flex-col border-b border-(--vscode-editorGroup-border) ${
					index === selectedIndex
						? "bg-(--vscode-quickInputList-focusBackground) text-(--vscode-quickInputList-focusForeground)"
						: ""
				} hover:bg-(--vscode-list-hoverBackground)`}
				id={`note-mention-menu-item-${index}`}
				key={`${note.taskGroupId ?? "own"}/${note.slug}`}
				onClick={() => onSelect(note)}
				onMouseEnter={() => setSelectedIndex(index)}
				role="option">
				<div className="flex items-center gap-1.5 whitespace-nowrap overflow-hidden">
					<span aria-hidden className="codicon codicon-book text-[12px]! shrink-0" />
					<span className="ph-no-capture font-bold truncate">{note.name}</span>
					<span className="ph-no-capture text-[0.85em] opacity-70 truncate">
						{note.isCurrentTask ? `#${note.slug}` : (note.insertText ?? `#${note.slug}`)}
					</span>
				</div>
				<div
					className={`text-[0.85em] truncate ${
						index === selectedIndex
							? "text-(--vscode-quickInputList-focusForeground)"
							: "text-(--vscode-descriptionForeground)"
					}`}>
					<span className="ph-no-capture">
						{note.isCurrentTask
							? note.description
							: [note.taskGroupTitle, note.description].filter(Boolean).join(" — ")}
					</span>
				</div>
			</div>
		)
		rows.push(item)
	})

	return (
		<div
			className="absolute bottom-[calc(100%-10px)] left-[15px] right-[15px] overflow-x-hidden z-1000"
			data-testid="note-mention-menu"
			// Keep focus in the textarea so picking doesn't blur the composer.
			onMouseDown={(event) => event.preventDefault()}>
			<div
				aria-activedescendant={`note-mention-menu-item-${selectedIndex}`}
				aria-label="Task notes"
				className="bg-(--vscode-dropdown-background) border border-(--vscode-editorGroup-border) rounded-[3px] shadow-[0_4px_10px_var(--vscode-widget-shadow)] flex flex-col overflow-y-auto"
				ref={menuRef}
				role="listbox"
				style={{ maxHeight: "min(200px, calc(50vh))", overscrollBehavior: "contain" }}>
				{rows}
			</div>
		</div>
	)
}

export default NoteMentionMenu
