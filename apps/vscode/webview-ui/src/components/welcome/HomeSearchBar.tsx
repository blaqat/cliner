import { useRef, useState } from "react"
import { expandTaskGroupInInbox } from "@/components/inbox/inboxUtils"
import { NewTaskGroupSheet } from "@/components/taskGroup/NewTaskGroupSheet"
import { useShortcut } from "@/utils/hooks"
import { getCurrentPlatform } from "@/utils/platformUtils"

interface HomeSearchBarProps {
	/** Opens the search view with what's typed so far. */
	onOpenSearch: (query: string) => void
}

/**
 * Home's always-visible search field (⌘K / Ctrl+K focuses it) and the "＋ Task"
 * button, which creates a task without starting a thread.
 */
export const HomeSearchBar = ({ onOpenSearch }: HomeSearchBarProps) => {
	const inputRef = useRef<HTMLInputElement>(null)
	const [query, setQuery] = useState("")
	const [sheetOpen, setSheetOpen] = useState(false)
	const shortcutLabel = getCurrentPlatform() === "mac" ? "⌘K" : "Ctrl+K"
	useShortcut("Meta+k", () => inputRef.current?.focus(), { disableTextInputs: false })

	return (
		<div className="flex shrink-0 items-center gap-1.5 px-5 pb-2" data-testid="home-search-bar">
			<label className="flex h-7 min-w-0 flex-1 cursor-text items-center gap-1.5 rounded-xs border border-input-border bg-input-background px-2 text-description focus-within:border-(--vscode-focusBorder)">
				<span aria-hidden className="codicon codicon-search text-[12px]!" />
				<input
					aria-label="Search threads, tasks, notes"
					className="min-w-0 flex-1 border-0 bg-transparent p-0 text-xs text-input-foreground outline-none placeholder:text-input-placeholder"
					data-testid="home-search-input"
					onChange={(event) => {
						setQuery(event.target.value)
						onOpenSearch(event.target.value)
					}}
					onClick={() => onOpenSearch(query)}
					placeholder="Search threads, tasks, notes…"
					ref={inputRef}
					type="text"
					value={query}
				/>
				<kbd className="shrink-0 rounded-xs border border-input-border px-1 text-[10px] leading-4 text-description">
					{shortcutLabel}
				</kbd>
			</label>
			<button
				className="flex h-7 shrink-0 cursor-pointer items-center rounded-xs border-0 bg-button-secondary-background px-2 text-xs text-button-secondary-foreground hover:bg-button-secondary-background-hover"
				data-testid="home-new-task-button"
				onClick={() => setSheetOpen(true)}
				title="New task without a thread"
				type="button">
				＋ Task
			</button>
			<NewTaskGroupSheet onCreated={expandTaskGroupInInbox} onOpenChange={setSheetOpen} open={sheetOpen} origin="home" />
		</div>
	)
}
