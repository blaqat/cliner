import { SetThreadTaskGroupRequest } from "@shared/proto/cline/task_group"
import type { TaskGroupSummary } from "@shared/task-groups"
import { extractTicketTags } from "@shared/ticket-tags"
import { memo, useMemo, useState } from "react"
import { expandTaskGroupInInbox } from "@/components/inbox/inboxUtils"
import {
	setComposerTaskGroup,
	setComposerTaskSheetOpen,
	useComposerTaskGroup,
	useComposerTaskSheetOpen,
} from "@/components/taskGroup/composerTaskGroup"
import { NewTaskGroupSheet } from "@/components/taskGroup/NewTaskGroupSheet"
import { TaskTagChip } from "@/components/taskGroup/TaskTagChip"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { cn } from "@/lib/utils"
import { TaskGroupServiceClient } from "@/services/grpc-client"

/** How many tasks the menu lists before the find field is needed. */
const RECENT_LIMIT = 8

function matchesQuery(group: TaskGroupSummary, query: string): boolean {
	const q = query.trim().toLowerCase()
	return !q || group.title.toLowerCase().includes(q) || group.tags.some((tag) => tag.value.toLowerCase().includes(q))
}

interface TaskGroupPickerProps {
	onOpenTaskGroup?: (taskGroupId: string) => void
}

/**
 * Composer task pill (`◇ No task ▾`). In a new thread it picks the task the
 * first message files the thread into; in an existing thread it moves the
 * thread right away. "＋ New task…" opens the new-task sheet.
 */
const TaskGroupPicker = ({ onOpenTaskGroup }: TaskGroupPickerProps) => {
	const { currentTaskItem, taskGroups } = useExtensionState()
	const pendingId = useComposerTaskGroup()
	const [open, setOpen] = useState(false)
	const [query, setQuery] = useState("")
	const threadId = currentTaskItem?.id
	const selectedId = threadId ? currentTaskItem?.taskGroupId : pendingId
	const groups = taskGroups ?? []
	const selected = groups.find((group) => group.id === selectedId)
	const recent = useMemo(
		() =>
			[...(taskGroups ?? [])]
				.sort((a, b) => b.updatedAt - a.updatedAt)
				.filter((group) => matchesQuery(group, query))
				.slice(0, RECENT_LIMIT),
		[taskGroups, query],
	)
	// Subagent threads belong to their root thread's task; they can't move on their own.
	if (currentTaskItem?.isSubagent) {
		return null
	}

	const pick = (id: string | undefined) => {
		setOpen(false)
		setQuery("")
		if (!threadId) {
			setComposerTaskGroup(id)
			return
		}
		if (id === selectedId) return
		void TaskGroupServiceClient.setThreadTaskGroup(
			SetThreadTaskGroupRequest.create({ threadId, taskGroupId: id ?? "" }),
		).catch((error) => console.error("Failed to move thread to task:", error))
	}

	const rowClass =
		"flex h-6 w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-xs border-0 bg-transparent px-2 text-left text-xs text-menu-foreground hover:bg-list-hover focus-visible:bg-list-hover focus-visible:outline-none"

	return (
		<Popover
			onOpenChange={(next) => {
				setOpen(next)
				if (!next) setQuery("")
			}}
			open={open}>
			<PopoverTrigger asChild>
				<button
					aria-label={selected ? `Task: ${selected.title}` : "No task"}
					className={cn(
						"flex h-4.5 min-w-[18px] max-w-36 shrink cursor-pointer items-center gap-1 overflow-hidden rounded-full border px-1 text-[11px] leading-none whitespace-nowrap",
						selected
							? "border-(--vscode-charts-purple)/50 bg-(--vscode-charts-purple)/15 text-foreground"
							: "border-dashed border-description/50 bg-transparent text-description hover:text-foreground",
						open && "border-(--vscode-focusBorder)",
					)}
					data-testid="task-group-picker"
					title={selected ? `Task: ${selected.title}` : "File this thread into a task"}
					type="button">
					{selected ? (
						<span aria-hidden className="codicon codicon-tasklist text-[11px]! text-(--vscode-charts-purple)" />
					) : (
						<span aria-hidden>◇</span>
					)}
					<span className="truncate">{selected ? selected.title : "No task"}</span>
					<span aria-hidden className="codicon codicon-chevron-down text-[10px]! opacity-70" />
				</button>
			</PopoverTrigger>
			<PopoverContent align="start" className="menu-rise w-64 p-1" data-testid="task-group-menu" side="top">
				<input
					aria-label="Find a task"
					autoFocus
					className="mb-1 w-full rounded-xs border border-input-border bg-input-background px-1.5 py-0.5 text-xs text-input-foreground placeholder:text-input-placeholder focus:outline focus:outline-1 focus:outline-(--vscode-focusBorder)"
					onChange={(event) => setQuery(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter" && recent[0]) {
							event.preventDefault()
							pick(recent[0].id)
						}
					}}
					placeholder="Find a task…"
					value={query}
				/>
				{recent.length > 0 && (
					<div className="px-2 pt-0.5 pb-0.5 text-[10px] font-medium uppercase tracking-wider text-description">
						Recent
					</div>
				)}
				{recent.map((group) => (
					<button className={rowClass} key={group.id} onClick={() => pick(group.id)} type="button">
						<span aria-hidden className="codicon codicon-tasklist text-[12px]! text-(--vscode-charts-purple)" />
						<span className="min-w-0 flex-1 truncate">{group.title}</span>
						{group.tags[0] && <TaskTagChip kind={group.tags[0].kind} value={group.tags[0].value} />}
						{group.id === selectedId && <span aria-label="Selected" className="codicon codicon-check text-[12px]!" />}
					</button>
				))}
				{query && recent.length === 0 && <div className="px-2 py-1 text-xs text-description">No matching tasks</div>}
				<button className={rowClass} onClick={() => pick(undefined)} type="button">
					<span aria-hidden className="w-3 text-center text-description">
						◇
					</span>
					<span className="flex-1">No task</span>
					<span className="text-[10.5px] text-description">plain thread</span>
					{!selectedId && <span aria-label="Selected" className="codicon codicon-check text-[12px]!" />}
				</button>
				<div className="my-1 border-t border-menu-foreground/10" />
				{threadId && selected && onOpenTaskGroup && (
					<button
						className={rowClass}
						onClick={() => {
							setOpen(false)
							onOpenTaskGroup(selected.id)
						}}
						type="button">
						<span aria-hidden className="codicon codicon-arrow-right text-[12px]!" />
						Open task
					</button>
				)}
				<button
					className={cn(rowClass, "text-link")}
					onClick={() => {
						setOpen(false)
						setComposerTaskSheetOpen(true)
					}}
					type="button">
					＋ New task…
				</button>
			</PopoverContent>
		</Popover>
	)
}

/**
 * The pill's "＋ New task…" sheet. Rendered once by the composer, outside the
 * pill, so it stays open when the pill moves into the "…" menu.
 */
export const ComposerTaskGroupSheet = memo(({ draftText = "" }: { draftText?: string }) => {
	const { currentTaskItem } = useExtensionState()
	const open = useComposerTaskSheetOpen()
	const threadId = currentTaskItem?.id
	const detectedTickets = useMemo(() => (open ? extractTicketTags(draftText) : []), [open, draftText])
	return (
		<NewTaskGroupSheet
			detectedTickets={detectedTickets}
			onCreated={(id) => {
				expandTaskGroupInInbox(id)
				if (!threadId) setComposerTaskGroup(id)
			}}
			onOpenChange={setComposerTaskSheetOpen}
			open={open}
			origin={threadId ? "thread" : "composer"}
			threadId={threadId}
		/>
	)
})

export default memo(TaskGroupPicker)
