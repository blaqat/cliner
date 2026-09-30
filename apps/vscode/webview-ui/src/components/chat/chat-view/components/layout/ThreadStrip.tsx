import type { ClineMessage } from "@shared/ExtensionMessage"
import { BotIcon, ChevronDownIcon, ChevronRightIcon, MessageSquareIcon, XIcon } from "lucide-react"
import { memo, useMemo, useState } from "react"
import { SessionStatusIcon } from "@/components/inbox/SessionStatusIcon"
import { openTask, stopSubagent } from "@/components/inbox/sessionActions"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { cn } from "@/lib/utils"
import { buildThreadItems, type ThreadItem } from "../../utils/threadUtils"

interface ThreadChipProps {
	item: ThreadItem
	onOpen: (item: ThreadItem) => void
	onOpenSubagent: ((item: ThreadItem) => void) | undefined
	onClose: (item: ThreadItem) => void
}

const ThreadChip = ({ item, onOpen, onOpenSubagent, onClose }: ThreadChipProps) => {
	// Subagent chips don't open a task; they scroll the transcript to the
	// subagent's status row and expand its details (via onOpenSubagent).
	const clickable = item.kind === "subagent" ? !!onOpenSubagent : !item.current
	const handleOpen = () => (item.kind === "subagent" ? onOpenSubagent?.(item) : onOpen(item))
	const tooltip =
		item.kind === "subagent"
			? `Subagent (${item.access === "write" ? "read + write" : "read-only"}): ${item.title}`
			: item.kind === "main"
				? "Main conversation"
				: `Aside: ${item.title}`

	return (
		<div
			aria-current={item.current || undefined}
			aria-label={clickable ? tooltip : undefined}
			className={cn(
				// Room for the title plus the kind and status icons before the strip starts scrolling.
				"group/chip flex h-5.5 min-w-[calc(12px+12px+10ch)] max-w-48 flex-[0_1_auto] items-center gap-1 rounded-xs border py-0.5 pr-1 pl-1.5 text-[11px] animate-row-in",
				item.current
					? "border-(--vscode-focusBorder) bg-selection/40 text-foreground"
					: "border-editor-group-border bg-input-background/50 text-description",
				clickable && "cursor-pointer hover:text-foreground hover:bg-list-hover",
			)}
			data-kind={item.kind}
			data-testid="thread-chip"
			onClick={clickable ? handleOpen : undefined}
			onKeyDown={
				clickable
					? (event) => {
							if (event.key === "Enter" || event.key === " ") {
								event.preventDefault()
								handleOpen()
							}
						}
					: undefined
			}
			role={clickable ? "button" : undefined}
			tabIndex={clickable ? 0 : undefined}
			title={tooltip}>
			{item.kind === "subagent" ? (
				<BotIcon className="size-3 shrink-0" />
			) : (
				<MessageSquareIcon className="size-3 shrink-0" />
			)}
			<span className="min-w-0 flex-1 truncate">{item.title}</span>
			{item.kind === "subagent" && (
				<span
					className={cn(
						"flex h-3.5 shrink-0 items-center rounded-[3px] border px-1 text-[9px] leading-none",
						item.access === "write" ? "border-warning/50 text-warning" : "border-editor-group-border",
					)}
					title={item.access === "write" ? "Can edit files" : "Read-only"}>
					{item.access === "write" ? "W" : "R"}
				</span>
			)}
			<SessionStatusIcon className={item.status === "running" ? "size-2.5" : undefined} status={item.status} />
			{item.kind !== "main" && (
				<button
					aria-label={`Close ${item.kind === "subagent" ? "subagent" : "aside"} ${item.title}`}
					className="flex size-3.5 shrink-0 items-center justify-center rounded-[3px] border-0 bg-transparent p-0 text-description opacity-60 hover:text-foreground hover:opacity-100 cursor-pointer"
					onClick={(event) => {
						event.stopPropagation()
						onClose(item)
					}}
					title={item.kind === "subagent" && item.status === "running" ? "Stop subagent" : "Close"}
					type="button">
					<XIcon className="size-2.5" />
				</button>
			)}
		</div>
	)
}

interface ThreadStripProps {
	messages: ClineMessage[]
	/** Scrolls to + expands a subagent's status row; when absent chips stay static. */
	onOpenSubagent?: (item: ThreadItem) => void
}

/**
 * Threads of the focused chat, directly under the task header: Main, its
 * asides and the subagents it spawned. Clicking an aside focuses it; Main
 * returns to the parent. Closing an aside only hides the chip (the session
 * keeps running); closing a running subagent aborts it via stopSubagent.
 */
const ThreadStrip = ({ messages, onOpenSubagent }: ThreadStripProps) => {
	const { currentTaskItem, taskHistory, sessionStatuses } = useExtensionState()
	const [open, setOpen] = useState(true)
	const [hiddenIds, setHiddenIds] = useState<ReadonlySet<string>>(() => new Set())

	const items = useMemo(
		() => buildThreadItems(currentTaskItem, taskHistory ?? [], sessionStatuses, messages, hiddenIds),
		[currentTaskItem, taskHistory, sessionStatuses, messages, hiddenIds],
	)

	if (items.length === 0) {
		return null
	}

	const main = items[0]
	const handleClose = (item: ThreadItem) => {
		setHiddenIds((current) => new Set(current).add(item.id))
		if (item.kind === "subagent" && item.status === "running" && currentTaskItem) {
			void stopSubagent(currentTaskItem.id, item.id)
		}
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
							onOpenSubagent={onOpenSubagent}
						/>
					))}
				</div>
			)}
		</div>
	)
}

export default memo(ThreadStrip)
