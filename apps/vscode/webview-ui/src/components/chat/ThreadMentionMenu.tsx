import { useEffect, useRef } from "react"
import {
	COMPLETION_MENU_CLASS,
	COMPLETION_SECTION_CLASS,
	completionDetailClass,
	completionItemClass,
} from "./completionMenuStyles"
import type { ThreadMentionOption } from "./threadMentions"

interface ThreadMentionMenuProps {
	threads: ThreadMentionOption[]
	selectedIndex: number
	setSelectedIndex: (index: number) => void
	onSelect: (thread: ThreadMentionOption) => void
}

/**
 * `thread:` completion list — any thread from any task, showing its title and
 * the task it's filed under. Same look as the note mention menu.
 */
const ThreadMentionMenu = ({ threads, selectedIndex, setSelectedIndex, onSelect }: ThreadMentionMenuProps) => {
	const menuRef = useRef<HTMLDivElement>(null)

	useEffect(() => {
		const menu = menuRef.current
		const selected = menu?.querySelector<HTMLElement>(`#thread-mention-menu-item-${selectedIndex}`)
		if (!menu || !selected) return
		const menuRect = menu.getBoundingClientRect()
		const selectedRect = selected.getBoundingClientRect()
		if (selectedRect.bottom > menuRect.bottom) {
			menu.scrollTop += selectedRect.bottom - menuRect.bottom
		} else if (selectedRect.top < menuRect.top) {
			menu.scrollTop -= menuRect.top - selectedRect.top
		}
	}, [selectedIndex])

	return (
		<div
			className="absolute bottom-[calc(100%-10px)] left-[15px] right-[15px] overflow-x-hidden z-1000"
			data-testid="thread-mention-menu"
			// Keep focus in the textarea so picking doesn't blur the composer.
			onMouseDown={(event) => event.preventDefault()}>
			<div
				aria-activedescendant={`thread-mention-menu-item-${selectedIndex}`}
				aria-label="Threads"
				className={COMPLETION_MENU_CLASS}
				ref={menuRef}
				role="listbox"
				style={{ maxHeight: "min(200px, calc(50vh))", overscrollBehavior: "contain" }}>
				<div className={COMPLETION_SECTION_CLASS} role="presentation">
					Threads
				</div>
				{threads.map((thread, index) => (
					<div
						aria-selected={index === selectedIndex}
						className={completionItemClass(index === selectedIndex)}
						id={`thread-mention-menu-item-${index}`}
						key={thread.id}
						onClick={() => onSelect(thread)}
						onMouseEnter={() => setSelectedIndex(index)}
						role="option">
						<div className="flex items-center gap-1.5 whitespace-nowrap overflow-hidden">
							<span aria-hidden className="codicon codicon-comment-discussion text-[12px]! shrink-0" />
							<span className="ph-no-capture font-bold truncate">{thread.title}</span>
						</div>
						<div className={completionDetailClass(index === selectedIndex)}>
							<span className="ph-no-capture">
								{[thread.taskGroupTitle, thread.id].filter(Boolean).join(" · ")}
							</span>
						</div>
					</div>
				))}
			</div>
		</div>
	)
}

export default ThreadMentionMenu
