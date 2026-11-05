import { SetThreadTaskGroupRequest } from "@shared/proto/cline/task_group"
import type { TaskGroupSummary } from "@shared/task-groups"
import { extractTicketTags } from "@shared/ticket-tags"
import { memo, useMemo, useState } from "react"
import {
	COMPOSER_LINE_CHIP_CLASS,
	COMPOSER_MENU_SCROLL_CLASS,
	MENU_ICON_CLASS,
	MENU_SEPARATOR_CLASS,
} from "@/components/common/menuStyles"
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
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { cn } from "@/lib/utils"
import { TaskGroupServiceClient } from "@/services/grpc-client"
import { BranchTaskSuggestion, type BranchTaskSuggestionOffer, useBranchTaskSuggestion } from "./BranchTaskSuggestion"
import { handleMenuKeyDown, MENU_HEADING_CLASS, MENU_ROW_CLASS } from "./menuKeyboard"

/** Task rows visible before the list scrolls (24px each). */
const VISIBLE_TASK_ROWS = 8

function matchesQuery(group: TaskGroupSummary, query: string): boolean {
	const q = query.trim().toLowerCase()
	return !q || group.title.toLowerCase().includes(q) || group.tags.some((tag) => tag.value.toLowerCase().includes(q))
}

/**
 * The task the chip shows: the thread's, the pending one for a new thread, or the fixed one on a
 * task page.
 */
function useWhereTask() {
	const { currentTaskItem, taskGroups } = useExtensionState()
	const pendingId = useComposerTaskGroup()
	const pageId = useComposerPageTaskGroup()
	const threadId = currentTaskItem?.id
	// On a task page, new threads always go into that task: the task part is fixed.
	const fixedId = !threadId ? pageId : undefined
	const selectedId = fixedId ?? (threadId ? currentTaskItem?.taskGroupId : pendingId)
	const selected = (taskGroups ?? []).find((group) => group.id === selectedId)
	const fixedTitle = fixedId ? (selected?.title ?? "This task") : undefined
	return {
		threadId,
		fixedId,
		selectedId,
		selected,
		fixedTitle,
		title: fixedTitle ?? selected?.title,
		/** Subagent threads belong to their root thread's task; the pill doesn't show for them. */
		hidden: !!currentTaskItem?.isSubagent,
	}
}

interface TaskPickerMenuProps {
	/** Closes the surrounding popover (after a pick, or before opening the new-task sheet). */
	onClose: () => void
	/**
	 * The branch → task suggestion, from `useBranchTaskSuggestion` in whatever stays mounted (the chip,
	 * the header), so a dismissal survives the menu closing.
	 */
	suggestion?: BranchTaskSuggestionOffer
	onOpenTaskGroup?: (taskGroupId: string) => void
}

/**
 * The task menu: a find field, recent tasks, "No task" and "New task…", plus a branch → task
 * suggestion on top. In a new thread a pick is the task the first message files the thread into;
 * in an existing thread it moves the thread right away (the header's ⋯ › Move to task). On a task
 * page the task is fixed, and the menu just says so.
 */
export function TaskPickerMenu({ onClose, onOpenTaskGroup, suggestion }: TaskPickerMenuProps) {
	const { taskGroups } = useExtensionState()
	const [query, setQuery] = useState("")
	const { threadId, selectedId, fixedTitle } = useWhereTask()
	const recent = useMemo(
		() => [...(taskGroups ?? [])].sort((a, b) => b.updatedAt - a.updatedAt).filter((group) => matchesQuery(group, query)),
		[taskGroups, query],
	)

	const pick = (id: string | undefined) => {
		onClose()
		if (!threadId) {
			setComposerTaskGroup(id)
			return
		}
		// Clicking the thread's own task opens it (there's no separate Open task row).
		if (id === selectedId) {
			if (id && onOpenTaskGroup) onOpenTaskGroup(id)
			return
		}
		void TaskGroupServiceClient.setThreadTaskGroup(
			SetThreadTaskGroupRequest.create({ threadId, taskGroupId: id ?? "" }),
		).catch((error) => console.error("Failed to move thread to task:", error))
	}

	return (
		<>
			{suggestion && <BranchTaskSuggestion onAccept={onClose} suggestion={suggestion} />}
			{fixedTitle ? (
				<div className="px-2 py-1 text-[12px] text-description" data-testid="where-fixed-task">
					New threads here go into <span className="text-foreground">{fixedTitle}</span>.
				</div>
			) : (
				<div aria-label="Task" className="flex min-h-0 flex-col" role="menu">
					{/* Pinned to the top, so it stays in reach even if the menu has to scroll. */}
					<div
						className={cn("sticky top-0 z-10 -mx-1 shrink-0 bg-menu px-1 py-1", !suggestion && "-mt-1")}
						data-testid="where-search">
						<Input
							aria-label="Find a task"
							autoFocus
							className="h-6 rounded-xs px-1.5 py-0 text-xs md:text-xs"
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
					</div>
					{recent.length > 0 && <div className={MENU_HEADING_CLASS}>{query ? "Matching tasks" : "Recent"}</div>}
					{/* Every task, newest first; past eight rows (or fewer when the window is short, down to two)
					    the list scrolls and the rows below stay put. */}
					<div
						className="overflow-y-auto overscroll-contain"
						data-testid="where-task-list"
						style={{ maxHeight: VISIBLE_TASK_ROWS * 24, minHeight: Math.min(recent.length, 2) * 24 }}>
						{recent.map((group) => (
							<button
								aria-checked={group.id === selectedId}
								className={MENU_ROW_CLASS}
								key={group.id}
								onClick={() => pick(group.id)}
								role="menuitemradio"
								title={threadId && group.id === selectedId && onOpenTaskGroup ? `Open ${group.title}` : undefined}
								type="button">
								<span
									aria-hidden
									className={cn(MENU_ICON_CLASS, "codicon-tasklist text-(--vscode-charts-purple)")}
								/>
								<span className="min-w-0 flex-1 truncate">{group.title}</span>
								{group.tags[0] && <TaskTagChip kind={group.tags[0].kind} value={group.tags[0].value} />}
								<span
									aria-hidden
									className={cn(MENU_ICON_CLASS, "codicon-check", group.id !== selectedId && "invisible")}
								/>
							</button>
						))}
					</div>
					{query && recent.length === 0 && (
						<div className="px-2 py-1 text-[12px] text-description">No matching tasks</div>
					)}
					<button
						aria-checked={!selectedId}
						className={MENU_ROW_CLASS}
						onClick={() => pick(undefined)}
						role="menuitemradio"
						type="button">
						<span aria-hidden className={cn(MENU_ICON_CLASS, "codicon-circle-slash text-description")} />
						<span className="flex-1">No task</span>
						<span className="text-[11px] text-description">plain thread</span>
						<span aria-hidden className={cn(MENU_ICON_CLASS, "codicon-check", !!selectedId && "invisible")} />
					</button>
					<div className={MENU_SEPARATOR_CLASS} />
					<button
						className={cn(MENU_ROW_CLASS, "text-link")}
						onClick={() => {
							onClose()
							setComposerTaskSheetOpen(true)
						}}
						role="menuitem"
						type="button">
						<span aria-hidden className={cn(MENU_ICON_CLASS, "codicon-add")} />
						New task…
					</button>
				</div>
			)}
		</>
	)
}

/** The task menu's popover look: one scrollbar (the task list's); the menu itself only scrolls, barless, as a last resort. */
export const TASK_MENU_CLASS = cn("flex w-64 flex-col p-1 [scrollbar-width:none]", COMPOSER_MENU_SCROLL_CLASS)

interface WherePillProps {
	onOpenTaskGroup?: (taskGroupId: string) => void
}

/**
 * "for [No task ⌄]" in the line under a new thread's composer: the task the thread goes into, the
 * fixed task on a task page. A branch → task suggestion shows as a ghost row at the top of the
 * menu, and a green branch codicon on the chip hints at it. Inside a thread it isn't shown: the
 * task is the header's crumb, and ⋯ › Move to task moves the thread.
 */
const WherePill = ({ onOpenTaskGroup }: WherePillProps) => {
	const suggestion = useBranchTaskSuggestion()
	const [open, setOpen] = useState(false)
	const { fixedId, fixedTitle, title, hidden } = useWhereTask()
	// Subagent threads belong to their root thread's task; they can't move on their own.
	if (hidden) {
		return null
	}
	const hasTask = !!title

	const pillLabel = [
		hasTask ? `Task: ${title}` : "No task",
		suggestion ? `suggested: ${suggestion.verb.toLowerCase()} ${suggestion.group.title}` : undefined,
	]
		.filter(Boolean)
		.join("; ")

	return (
		<Popover onOpenChange={setOpen} open={open}>
			<PopoverTrigger asChild>
				<button
					aria-label={pillLabel}
					className={cn(COMPOSER_LINE_CHIP_CLASS, "max-w-48 shrink")}
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
									: "No task. Click to file this thread into one"
					}
					type="button">
					<span
						aria-hidden
						className={cn(
							"codicon codicon-tasklist shrink-0 text-[12px]!",
							hasTask && "text-(--vscode-charts-purple)",
						)}
					/>
					<span className={cn("min-w-0 truncate", hasTask && "text-foreground")}>{hasTask ? title : "No task"}</span>
					{suggestion && (
						<span
							aria-hidden
							className="codicon codicon-git-branch shrink-0 text-[11px]! text-success"
							data-testid="where-pill-suggestion-hint"
						/>
					)}
					<span aria-hidden className="codicon codicon-chevron-down shrink-0 text-[10px]! opacity-70" />
				</button>
			</PopoverTrigger>
			<PopoverContent
				align="start"
				className={cn("menu-rise", TASK_MENU_CLASS)}
				data-testid="where-menu"
				onKeyDown={handleMenuKeyDown}
				side="top">
				<TaskPickerMenu onClose={() => setOpen(false)} onOpenTaskGroup={onOpenTaskGroup} suggestion={suggestion} />
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
