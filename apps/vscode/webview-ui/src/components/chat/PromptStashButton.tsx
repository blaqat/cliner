import { ArchiveIcon, XIcon } from "lucide-react"
import { memo, useEffect, useState } from "react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import { describeStashEntry, type PromptStashEntry } from "./chat-view/utils/promptStash"

function formatAge(ts: number, now: number): string {
	const minutes = Math.floor((now - ts) / 60_000)
	if (minutes < 1) {
		return "just now"
	}
	if (minutes < 60) {
		return `${minutes}m ago`
	}
	const hours = Math.floor(minutes / 60)
	return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`
}

interface PromptStashButtonProps {
	entries: PromptStashEntry[]
	onRestore: (id: string) => void
	onDelete: (id: string) => void
}

/**
 * Stash icon next to send. Rendered only while the stash has entries; opens a
 * list where clicking an entry restores it and the x deletes it.
 */
const PromptStashButton = ({ entries, onRestore, onDelete }: PromptStashButtonProps) => {
	const [open, setOpen] = useState(false)
	const count = entries.length

	useEffect(() => {
		if (count === 0) {
			setOpen(false)
		}
	}, [count])

	if (count === 0) {
		return null
	}

	const now = Date.now()

	return (
		<Popover onOpenChange={setOpen} open={open}>
			<PopoverTrigger asChild>
				<button
					aria-label={`Stashed prompts (${count})`}
					className={cn(
						"input-icon-button relative flex items-center mr-1.5 bg-transparent border-0 p-0 text-description animate-in fade-in-0 zoom-in-90 motion-reduce:animate-none",
						open && "text-foreground",
					)}
					data-testid="stash-button"
					title={`Stashed prompts (${count})`}
					type="button">
					<ArchiveIcon size={13} />
					<span className="absolute -top-1.5 -right-2 min-w-3 h-3 px-0.5 rounded-full bg-badge-background text-badge-foreground text-[9px] leading-3 text-center">
						{count}
					</span>
				</button>
			</PopoverTrigger>
			<PopoverContent
				align="end"
				className="menu-rise w-72 max-w-[calc(100vw-2rem)] p-1"
				data-testid="stash-popover"
				side="top">
				<div className="px-1.5 py-1 text-xs text-description">Stashed prompts</div>
				<ul className="m-0 p-0 list-none max-h-64 overflow-y-auto">
					{entries.map((entry) => (
						<li
							className="group flex items-center gap-1 rounded-xs px-1.5 py-1 cursor-pointer hover:bg-list-hover"
							data-testid="stash-entry"
							key={entry.id}
							onClick={() => {
								setOpen(false)
								onRestore(entry.id)
							}}>
							<div className="flex-1 min-w-0">
								<div className="truncate text-sm">{describeStashEntry(entry)}</div>
								<div className="text-xs text-description">
									{formatAge(entry.ts, now)}
									{entry.quotes.length > 0 &&
										` · ${entry.quotes.length} quote${entry.quotes.length === 1 ? "" : "s"}`}
								</div>
							</div>
							<button
								aria-label="Delete stashed prompt"
								className="shrink-0 bg-transparent border-0 p-0.5 rounded-xs text-description hover:text-foreground cursor-pointer"
								onClick={(e) => {
									e.stopPropagation()
									onDelete(entry.id)
								}}
								title="Delete"
								type="button">
								<XIcon size={12} />
							</button>
						</li>
					))}
				</ul>
			</PopoverContent>
		</Popover>
	)
}

export default memo(PromptStashButton)
