import { ClineMessage } from "@shared/ExtensionMessage"
import { StringArrayRequest, StringRequest } from "@shared/proto/cline/common"
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { buildThreadPath, type LineageRow, threadTitle } from "@/components/chat/chat-view/utils/threadUtils"
import Thumbnails from "@/components/common/Thumbnails"
import { countBackgroundRunning } from "@/components/inbox/inboxUtils"
import { openTask, renameTask, toggleTaskSettled } from "@/components/inbox/sessionActions"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { cn } from "@/lib/utils"
import { TaskServiceClient } from "@/services/grpc-client"
import { getEnvironmentColor } from "@/utils/environmentColors"
import { Breadcrumb, type Crumb } from "./Breadcrumb"
import { HeaderIconButton } from "./HeaderIconButton"
import { highlightText } from "./Highlights"
import { SubagentPanelButton } from "./SubagentPanel"
import TaskWorkingDirectoryBadge from "./TaskWorkingDirectoryBadge"

const IS_DEV = process.env.IS_DEV === "true"

interface TaskHeaderProps {
	task: ClineMessage
	/** Back to home; the chat keeps running. */
	onClose: () => void
	/** Opens a transcript-only subagent from the panel by scrolling to its status row. */
	onOpenSubagentPreview?: (row: LineageRow) => void
	/** Opens the task (group) page from its crumb. */
	onOpenTaskGroup?: (taskGroupId: string) => void
}

/** Title for the header: the thread's title, else the first user message. */
export function headerTitle(title: string | undefined, firstMessage: string | undefined): string {
	return (title?.trim() || firstMessage?.trim() || "New task").replace(/\s+/g, " ")
}

const MENU_ITEM_CLASS =
	"flex h-6 w-full items-center gap-2 rounded-xs border-0 bg-transparent px-2 text-left text-[12px] text-menu-foreground cursor-pointer hover:bg-list-hover focus-visible:outline focus-visible:outline-1 focus-visible:outline-(--vscode-focusBorder) disabled:cursor-not-allowed disabled:opacity-50"

/**
 * One compact row: the breadcrumb path to this thread (home, task, ancestor
 * threads, then the renamable current title) and codicon actions — subagents,
 * settle, delete, close — with less frequent actions, including the full first
 * message, behind "…". Context, tokens and cost live in the composer.
 */
const TaskHeader: React.FC<TaskHeaderProps> = ({ task, onClose, onOpenSubagentPreview, onOpenTaskGroup }) => {
	const { currentTaskItem, environment, workspaceRoots, platform, sessionStatuses, taskHistory, taskGroups } =
		useExtensionState()
	const [menuOpen, setMenuOpen] = useState(false)
	const [copied, setCopied] = useState(false)
	const [expanded, setExpanded] = useState(false)
	// Shown until the saved title comes back through history.
	const [pendingTitle, setPendingTitle] = useState<string>()
	const rootRef = useRef<HTMLDivElement>(null)
	const moreRef = useRef<HTMLButtonElement>(null)
	const panelRef = useRef<HTMLDivElement>(null)

	const taskId = currentTaskItem?.id
	const settled = !!currentTaskItem?.isSettled
	const savedTitle = currentTaskItem?.title
	const title = headerTitle(
		pendingTitle ?? savedTitle,
		(currentTaskItem?.task && threadTitle({ ...currentTaskItem, title: undefined })) || task.text,
	)
	const imageCount = task.images?.length ?? 0
	const fileCount = task.files?.length ?? 0
	const backgroundRunning = countBackgroundRunning(sessionStatuses, taskId, taskHistory)

	// biome-ignore lint/correctness/useExhaustiveDependencies: the pending title clears once the saved one (or the thread) changes
	useEffect(() => setPendingTitle(undefined), [taskId, savedTitle])

	const crumbs = useMemo((): Crumb[] => {
		const path = buildThreadPath(currentTaskItem, taskHistory ?? [])
		const ancestors = path.threads.slice(0, -1)
		const groupId = path.taskGroupId
		return [
			{ id: "home", kind: "home", label: "Home", onSelect: onClose },
			...(groupId
				? [
						{
							id: `task:${groupId}`,
							kind: "task" as const,
							label: taskGroups?.find((group) => group.id === groupId)?.title ?? "Task",
							onSelect: () => onOpenTaskGroup?.(groupId),
						},
					]
				: []),
			...ancestors.map((thread) => ({
				id: thread.id,
				kind: "thread" as const,
				label: thread.title,
				sub: thread.sub,
				onSelect: () => void openTask(thread.id),
			})),
			{ id: taskId ?? "current", kind: "thread", label: title, sub: !!currentTaskItem?.parentTaskId },
		]
	}, [currentTaskItem, taskHistory, taskGroups, taskId, title, onClose, onOpenTaskGroup])

	const rename = useCallback(
		(next: string) => {
			if (!taskId) return
			setPendingTitle(next)
			void renameTask(taskId, next).then((ok) => {
				if (!ok) setPendingTitle(undefined)
			})
		},
		[taskId],
	)

	// The expanded first message closes on Esc or a click outside the header.
	useEffect(() => {
		if (!expanded) return
		panelRef.current?.focus({ preventScroll: true })
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return
			event.stopPropagation()
			setExpanded(false)
			moreRef.current?.focus()
		}
		const onPointerDown = (event: PointerEvent) => {
			if (!rootRef.current?.contains(event.target as Node)) setExpanded(false)
		}
		document.addEventListener("keydown", onKeyDown, true)
		document.addEventListener("pointerdown", onPointerDown)
		return () => {
			document.removeEventListener("keydown", onKeyDown, true)
			document.removeEventListener("pointerdown", onPointerDown)
		}
	}, [expanded])

	const copyFirstMessage = useCallback(() => {
		if (!task.text) return
		void navigator.clipboard.writeText(task.text).then(() => {
			setCopied(true)
			setTimeout(() => setCopied(false), 1500)
		})
	}, [task.text])

	return (
		<div className="px-4 pt-2 pb-1" ref={rootRef}>
			<div
				className="flex h-7.5 items-center gap-1 rounded-xs border border-transparent pl-0.5 pr-1 bg-(--vscode-toolbar-hoverBackground)/40"
				data-testid="task-header"
				style={{ borderColor: getEnvironmentColor(environment, "border") }}>
				<Breadcrumb crumbs={crumbs} onRename={taskId ? rename : undefined} />
				{(imageCount > 0 || fileCount > 0) && (
					<span
						aria-label={`${imageCount + fileCount} attachment${imageCount + fileCount === 1 ? "" : "s"}`}
						className="codicon codicon-paperclip shrink-0 text-[12px] text-description"
						role="img"
					/>
				)}
				<TaskWorkingDirectoryBadge
					platform={platform}
					taskCwd={currentTaskItem?.cwdOnTaskInitialization}
					workspaceRoots={workspaceRoots}
				/>
				<div className="flex shrink-0 items-center gap-0.5">
					<SubagentPanelButton onOpenPreview={onOpenSubagentPreview} />
					{taskId && (
						<HeaderIconButton
							data-testid="settle-task"
							icon={settled ? "issue-reopened" : "check"}
							label={settled ? "Unsettle task" : "Settle task"}
							onClick={() =>
								void toggleTaskSettled(taskId).then(() => {
									if (!settled) onClose()
								})
							}
							tooltip={settled ? "Move back to Active" : "Settle: move to the Settled list and return home"}
						/>
					)}
					<HeaderIconButton
						disabled={!taskId}
						icon="trash"
						label="Delete task"
						onClick={() =>
							taskId && TaskServiceClient.deleteTasksWithIds(StringArrayRequest.create({ value: [taskId] }))
						}
						tooltip="Delete task (asks to confirm)"
					/>
					<Popover onOpenChange={setMenuOpen} open={menuOpen}>
						<PopoverTrigger asChild>
							<HeaderIconButton icon="ellipsis" label="More actions" ref={moreRef} />
						</PopoverTrigger>
						<PopoverContent align="end" className="w-56 p-1 motion-reduce:animate-none" side="bottom">
							<div className="flex flex-col" role="menu">
								<button
									aria-controls="task-header-first-message"
									aria-expanded={expanded}
									className={MENU_ITEM_CLASS}
									disabled={!task.text && imageCount + fileCount === 0}
									onClick={() => {
										setMenuOpen(false)
										setExpanded((value) => !value)
									}}
									role="menuitem"
									type="button">
									<span
										aria-hidden
										className={cn(
											"codicon text-[13px]",
											expanded ? "codicon-chevron-up" : "codicon-chevron-down",
										)}
									/>
									{expanded ? "Hide first message" : "Show first message"}
								</button>
								<button
									className={MENU_ITEM_CLASS}
									disabled={!task.text}
									onClick={copyFirstMessage}
									role="menuitem"
									type="button">
									<span
										aria-hidden
										className={cn("codicon text-[13px]", copied ? "codicon-check" : "codicon-copy")}
									/>
									{copied ? "Copied" : "Copy first message"}
								</button>
								{backgroundRunning > 0 && (
									<button
										className={MENU_ITEM_CLASS}
										onClick={() => {
											setMenuOpen(false)
											onClose()
										}}
										role="menuitem"
										type="button">
										<span
											aria-hidden
											className="codicon codicon-loading codicon-modifier-spin text-[13px] motion-reduce:animate-none"
										/>
										{backgroundRunning} other chat{backgroundRunning === 1 ? "" : "s"} running
									</button>
								)}
								{IS_DEV && taskId && (
									<button
										className={MENU_ITEM_CLASS}
										onClick={() => {
											setMenuOpen(false)
											TaskServiceClient.exportTaskWithId(StringRequest.create({ value: taskId })).catch(
												(err) => console.error("Failed to export task:", err),
											)
										}}
										role="menuitem"
										type="button">
										<span aria-hidden className="codicon codicon-go-to-file text-[13px]" />
										Open conversation history file
									</button>
								)}
							</div>
						</PopoverContent>
					</Popover>
					<HeaderIconButton
						icon="close"
						label="Close"
						onClick={onClose}
						tooltip="Close: back to home, the chat keeps running"
					/>
				</div>
			</div>
			{expanded && (
				<div
					aria-label="First message"
					className="mt-1 max-h-[40vh] overflow-y-auto rounded-xs border border-editor-group-border bg-(--vscode-editor-background) p-2 outline-none animate-in fade-in-0 slide-in-from-top-1 motion-reduce:animate-none"
					data-testid="task-header-first-message"
					id="task-header-first-message"
					ref={panelRef}
					role="region"
					tabIndex={-1}>
					<div
						className="ph-no-capture whitespace-pre-wrap break-words text-[13px]"
						data-testid="task-header-full-text">
						{highlightText(task.text, false)}
					</div>
					{(imageCount > 0 || fileCount > 0) && (
						<Thumbnails className="mt-2" files={task.files ?? []} images={task.images ?? []} />
					)}
				</div>
			)}
		</div>
	)
}

export default TaskHeader
