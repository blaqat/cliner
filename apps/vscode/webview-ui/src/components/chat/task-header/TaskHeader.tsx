import { ClineMessage } from "@shared/ExtensionMessage"
import { StringArrayRequest, StringRequest } from "@shared/proto/cline/common"
import React, { useCallback, useEffect, useRef, useState } from "react"
import type { LineageRow } from "@/components/chat/chat-view/utils/threadUtils"
import Thumbnails from "@/components/common/Thumbnails"
import { countBackgroundRunning } from "@/components/inbox/inboxUtils"
import { toggleTaskSettled } from "@/components/inbox/sessionActions"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { cn } from "@/lib/utils"
import { TaskServiceClient } from "@/services/grpc-client"
import { getEnvironmentColor } from "@/utils/environmentColors"
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
}

/** Title for the header: the thread's title, else the first user message. */
export function headerTitle(title: string | undefined, firstMessage: string | undefined): string {
	return (title?.trim() || firstMessage?.trim() || "New task").replace(/\s+/g, " ")
}

const MENU_ITEM_CLASS =
	"flex h-6 w-full items-center gap-2 rounded-xs border-0 bg-transparent px-2 text-left text-[12px] text-menu-foreground cursor-pointer hover:bg-list-hover focus-visible:outline focus-visible:outline-1 focus-visible:outline-(--vscode-focusBorder) disabled:cursor-not-allowed disabled:opacity-50"

/**
 * One compact row: the thread title (click to expand the full first message
 * with its attachments) and
 * codicon actions — subagents, settle, delete, close — with less frequent
 * actions behind "…". Context, tokens and cost live in the composer.
 */
const TaskHeader: React.FC<TaskHeaderProps> = ({ task, onClose, onOpenSubagentPreview }) => {
	const { currentTaskItem, environment, workspaceRoots, platform, sessionStatuses, taskHistory } = useExtensionState()
	const [menuOpen, setMenuOpen] = useState(false)
	const [copied, setCopied] = useState(false)
	const [expanded, setExpanded] = useState(false)
	const rootRef = useRef<HTMLDivElement>(null)
	const titleRef = useRef<HTMLButtonElement>(null)
	const panelRef = useRef<HTMLDivElement>(null)

	const taskId = currentTaskItem?.id
	const settled = !!currentTaskItem?.isSettled
	const title = headerTitle(currentTaskItem?.task, task.text)
	const imageCount = task.images?.length ?? 0
	const fileCount = task.files?.length ?? 0
	const backgroundRunning = countBackgroundRunning(sessionStatuses, taskId, taskHistory)

	// The expanded first message closes on Esc or a click outside the header.
	useEffect(() => {
		if (!expanded) return
		panelRef.current?.focus({ preventScroll: true })
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return
			event.stopPropagation()
			setExpanded(false)
			titleRef.current?.focus()
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
				className="flex h-7.5 items-center gap-1 rounded-xs border border-transparent pl-2 pr-1 bg-(--vscode-toolbar-hoverBackground)/40"
				data-testid="task-header"
				style={{ borderColor: getEnvironmentColor(environment, "border") }}>
				<button
					aria-controls="task-header-first-message"
					aria-expanded={expanded}
					className="ph-no-capture flex min-w-0 flex-1 items-center gap-1 border-0 bg-transparent p-0 text-left text-[13px] font-semibold text-foreground cursor-pointer focus-visible:outline focus-visible:outline-1 focus-visible:outline-(--vscode-focusBorder)"
					data-testid="task-header-title"
					onClick={() => setExpanded((value) => !value)}
					ref={titleRef}
					title={expanded ? "Hide first message" : "Show first message"}
					type="button">
					<span className="min-w-0 truncate" data-testid="task-header-title-text">
						{title}
					</span>
					<span
						aria-hidden
						className={cn(
							"codicon codicon-chevron-down shrink-0 text-[12px] text-description transition-transform duration-150 motion-reduce:transition-none",
							expanded && "rotate-180",
						)}
					/>
				</button>
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
							<HeaderIconButton icon="ellipsis" label="More actions" />
						</PopoverTrigger>
						<PopoverContent align="end" className="w-56 p-1 motion-reduce:animate-none" side="bottom">
							<div className="flex flex-col" role="menu">
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
