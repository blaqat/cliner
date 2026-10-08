import { ChevronDownIcon, ChevronRightIcon, MessageSquareIcon, XIcon } from "lucide-react"
import { memo, useMemo, useState } from "react"
import { SessionStatusIcon } from "@/components/inbox/SessionStatusIcon"
import { openTask } from "@/components/inbox/sessionActions"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { cn } from "@/lib/utils"
import { buildThreadItems, type ThreadItem } from "../../utils/threadUtils"

interface ThreadChipProps {
	item: ThreadItem
	onOpen: (item: ThreadItem) => void
	onClose: (item: ThreadItem) => void
}

const ThreadChip = ({ item, onOpen, onClose }: ThreadChipProps) => {
	const clickable = !item.current
	const tooltip = item.kind === "main" ? "Main conversation" : `Aside: ${item.title}`

	return (
		<div
			aria-current={item.current || undefined}
			aria-label={clickable ? tooltip : undefined}
			className={cn(
				// Room for the title plus the kind and status icons before the strip starts scrolling.
				"group/chip flex h-5.5 min-w-[calc(12px+12px+10ch)] max-w-48 flex-[0_1_auto] items-center gap-1 rounded-xs border py-0.5 pr-1 pl-1.5 text-[11px] animate-row-in motion-reduce:animate-none",
				item.current
					? "border-(--vscode-focusBorder) bg-selection/40 text-foreground"
					: "border-editor-group-border bg-input-background/50 text-description",
				clickable && "cursor-pointer hover:text-foreground hover:bg-list-hover",
			)}
			data-kind={item.kind}
			data-testid="thread-chip"
			onClick={clickable ? () => onOpen(item) : undefined}
			onKeyDown={
				clickable
					? (event) => {
							if (event.key === "Enter" || event.key === " ") {
								event.preventDefault()
								onOpen(item)
							}
						}
					: undefined
			}
			role={clickable ? "button" : undefined}
			tabIndex={clickable ? 0 : undefined}
			title={tooltip}>
			<MessageSquareIcon className="size-3 shrink-0" />
			<span className="min-w-0 flex-1 truncate">{item.title}</span>
			<SessionStatusIcon className={item.status === "running" ? "size-2.5" : undefined} status={item.status} />
			{item.kind !== "main" && (
				<button
					aria-label={`Close aside ${item.title}`}
					className="flex size-3.5 shrink-0 items-center justify-center rounded-[3px] border-0 bg-transparent p-0 text-description opacity-60 hover:text-foreground hover:opacity-100 cursor-pointer"
					onClick={(event) => {
						event.stopPropagation()
						onClose(item)
					}}
					title="Close"
					type="button">
					<XIcon className="size-2.5" />
				</button>
			)}
		</div>
	)
}

/**
 * Human-made threads of the focused chat, directly under the task header:
 * Main and its asides. Hidden when the chat has no asides; subagents are in
 * the header's subagent panel. Closing an aside only hides the chip (the
 * session keeps running).
 */
const ThreadStrip = () => {
	const { currentTaskItem, taskHistory, sessionStatuses } = useExtensionState()
	const [open, setOpen] = useState(true)
	const [hiddenIds, setHiddenIds] = useState<ReadonlySet<string>>(() => new Set())

	const items = useMemo(
		() => buildThreadItems(currentTaskItem, taskHistory ?? [], sessionStatuses, hiddenIds),
		[currentTaskItem, taskHistory, sessionStatuses, hiddenIds],
	)

	if (items.length === 0) {
		return null
	}

	const main = items[0]
	const handleClose = (item: ThreadItem) => {
		setHiddenIds((current) => new Set(current).add(item.id))
		if (item.current) {
			void openTask(main.id)
		}
	}

	return (
		<div className="mx-4 mb-1 flex flex-col gap-1 border-b border-editor-group-border pb-1.5" data-testid="thread-strip">
			<button
				aria-expanded={open}
				className="flex w-fit items-center gap-1 border-0 bg-transparent p-0 text-[10.5px] font-medium uppercase tracking-wider text-description hover:text-foreground cursor-pointer"
				onClick={() => setOpen((value) => !value)}
				type="button">
				{open ? <ChevronDownIcon className="size-3" /> : <ChevronRightIcon className="size-3" />}
				Threads
				<span className="opacity-70">{items.length - 1}</span>
			</button>
			{open && (
				<div className="flex gap-1 overflow-x-auto pb-0.5 [scrollbar-width:thin]">
					{items.map((item) => (
						<ThreadChip
							item={item}
							key={`${item.kind}:${item.id}`}
							onClose={handleClose}
							onOpen={(it) => void openTask(it.id)}
						/>
					))}
				</div>
			)}
		</div>
	)
}

export default memo(ThreadStrip)
