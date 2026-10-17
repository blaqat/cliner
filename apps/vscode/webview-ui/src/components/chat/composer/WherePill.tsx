import { SetThreadTaskGroupRequest } from "@shared/proto/cline/task_group"
import type { TaskGroupSummary } from "@shared/task-groups"
import { extractTicketTags } from "@shared/ticket-tags"
import { memo, useMemo, useState } from "react"
import { expandTaskGroupInInbox } from "@/components/inbox/inboxUtils"
import {
	setComposerTaskGroup,
	setComposerTaskSheetOpen,
	useComposerPageTaskGroup,
	useComposerTaskGroup,
	useComposerTaskSheetOpen,
} from "@/components/taskGroup/composerTaskGroup"
import { NewTaskGroupSheet } from "@/components/taskGroup/NewTaskGroupSheet"
import { TaskTagChip } from "@/components/taskGroup/TaskTagChip"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { cn } from "@/lib/utils"
import { TaskGroupServiceClient } from "@/services/grpc-client"
import { BranchTaskSuggestion, useBranchTaskSuggestion } from "./BranchTaskSuggestion"
import { handleMenuKeyDown, MENU_HEADING_CLASS, MENU_ROW_CLASS } from "./menuKeyboard"
import { WorktreeBadgeSlot, WorktreeToggleSlot } from "./worktreeSlot"

/** How many tasks the menu lists before the find field is needed. */
const RECENT_LIMIT = 8

function matchesQuery(group: TaskGroupSummary, query: string): boolean {
	const q = query.trim().toLowerCase()
	return !q || group.title.toLowerCase().includes(q) || group.tags.some((tag) => tag.value.toLowerCase().includes(q))
}

interface WherePillProps {
	onOpenTaskGroup?: (taskGroupId: string) => void
}

/**
 * The composer's "where" pill: the thread's task (`◇ No task ▾`) and, once worktrees land, its
 * workspace. In a new thread it picks the task the first message files the thread into; in an
 * existing thread it moves the thread right away. A branch → task suggestion shows as a ghost row
 * at the top of the menu, and a green ⎇ on the pill hints at it.
 */
const WherePill = ({ onOpenTaskGroup }: WherePillProps) => {
	const { currentTaskItem, taskGroups } = useExtensionState()
	const pendingId = useComposerTaskGroup()
	const pageId = useComposerPageTaskGroup()
	const suggestion = useBranchTaskSuggestion()
	const [open, setOpen] = useState(false)
	const [query, setQuery] = useState("")
	const threadId = currentTaskItem?.id
	const groups = taskGroups ?? []
	// On a task page, new threads always go into that task: the task part is fixed.
	const fixedId = !threadId ? pageId : undefined
	const selectedId = fixedId ?? (threadId ? currentTaskItem?.taskGroupId : pendingId)
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
	const fixedTitle = fixedId ? (selected?.title ?? "This task") : undefined
	const title = fixedTitle ?? selected?.title
	const hasTask = !!title

	const close = () => {
		setOpen(false)
		setQuery("")
	}
	const pick = (id: string | undefined) => {
		close()
		if (!threadId) {
			setComposerTaskGroup(id)
			return
		}
		if (id === selectedId) return
		void TaskGroupServiceClient.setThreadTaskGroup(
			SetThreadTaskGroupRequest.create({ threadId, taskGroupId: id ?? "" }),
		).catch((error) => console.error("Failed to move thread to task:", error))
	}

	const pillLabel = [
		hasTask ? `Task: ${title}` : "No task",
		suggestion ? `suggested: ${suggestion.verb.toLowerCase()} ${suggestion.group.title}` : undefined,
	]
		.filter(Boolean)
		.join("; ")

	return (
		<Popover
			onOpenChange={(next) => {
				setOpen(next)
				if (!next) setQuery("")
			}}
			open={open}>
			<PopoverTrigger asChild>
				<button
					aria-label={pillLabel}
					className={cn(
						"flex h-4.5 min-w-[18px] max-w-40 shrink cursor-pointer items-center gap-1 overflow-hidden rounded-full border px-1 text-[11px] leading-none whitespace-nowrap",
						hasTask
							? "border-(--vscode-charts-purple)/50 bg-(--vscode-charts-purple)/15 text-foreground"
							: "border-dashed border-description/50 bg-transparent text-description hover:text-foreground",
						open && "border-(--vscode-focusBorder)",
					)}
					data-fixed={fixedId ? "true" : undefined}
					data-suggestion={suggestion ? "true" : undefined}
					data-testid="where-pill"
					title={
						fixedTitle
							? `New threads here go into ${fixedTitle}`
							: suggestion
								? `${hasTask ? `Task: ${title}` : "No task"} · ${suggestion.verb} ${suggestion.group.title}? (it has the branch you're on)`
								: hasTask
									? `Task: ${title}`
									: "File this thread into a task"
					}
					type="button">
					{hasTask ? (
						<span aria-hidden className="codicon codicon-tasklist text-[11px]! text-(--vscode-charts-purple)" />
					) : (
						<span aria-hidden>◇</span>
					)}
					<span className="truncate">{title ?? "No task"}</span>
					<WorktreeBadgeSlot threadId={threadId} />
					{suggestion && (
						<span
							aria-hidden
							className="shrink-0 text-(--vscode-charts-green)"
							data-testid="where-pill-suggestion-hint">
							⎇
						</span>
					)}
					<span aria-hidden className="codicon codicon-chevron-down shrink-0 text-[10px]! opacity-70" />
				</button>
			</PopoverTrigger>
			<PopoverContent
				align="start"
				className="menu-rise w-64 p-1"
				data-testid="where-menu"
				onKeyDown={handleMenuKeyDown}
				side="top">
				{suggestion && <BranchTaskSuggestion onAccept={close} suggestion={suggestion} />}
				{fixedTitle ? (
					<div className="px-2 py-1 text-xs text-description" data-testid="where-fixed-task">
						New threads here go into <span className="text-foreground">{fixedTitle}</span>.
					</div>
				) : (
					<div aria-label="Task" role="menu">
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
						{recent.length > 0 && <div className={MENU_HEADING_CLASS}>Recent</div>}
						{recent.map((group) => (
							<button
								aria-checked={group.id === selectedId}
								className={MENU_ROW_CLASS}
								key={group.id}
								onClick={() => pick(group.id)}
								role="menuitemradio"
								type="button">
								<span
									aria-hidden
									className="codicon codicon-tasklist text-[12px]! text-(--vscode-charts-purple)"
								/>
								<span className="min-w-0 flex-1 truncate">{group.title}</span>
								{group.tags[0] && <TaskTagChip kind={group.tags[0].kind} value={group.tags[0].value} />}
								{group.id === selectedId && <span aria-hidden className="codicon codicon-check text-[12px]!" />}
							</button>
						))}
						{query && recent.length === 0 && (
							<div className="px-2 py-1 text-xs text-description">No matching tasks</div>
						)}
						<button
							aria-checked={!selectedId}
							className={MENU_ROW_CLASS}
							onClick={() => pick(undefined)}
							role="menuitemradio"
							type="button">
							<span aria-hidden className="w-3 text-center text-description">
								◇
							</span>
							<span className="flex-1">No task</span>
							<span className="text-[10.5px] text-description">plain thread</span>
							{!selectedId && <span aria-hidden className="codicon codicon-check text-[12px]!" />}
						</button>
						<div className="my-1 border-t border-menu-foreground/10" />
						{threadId && selected && onOpenTaskGroup && (
							<button
								className={MENU_ROW_CLASS}
								onClick={() => {
									close()
									onOpenTaskGroup(selected.id)
								}}
								role="menuitem"
								type="button">
								<span aria-hidden className="codicon codicon-arrow-right text-[12px]!" />
								Open task
							</button>
						)}
						<button
							className={cn(MENU_ROW_CLASS, "text-link")}
							onClick={() => {
								close()
								setComposerTaskSheetOpen(true)
							}}
							role="menuitem"
							type="button">
							＋ New task…
						</button>
					</div>
				)}
				<WorktreeToggleSlot threadId={threadId} />
			</PopoverContent>
		</Popover>
	)
}

/**
 * The pill's "＋ New task…" sheet. Rendered once by the composer, outside the pill's popover, so it
 * stays open after the menu closes.
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

export default memo(WherePill)
