import { DeleteTaskGroupRequest, TaskTagList, UpdateTaskGroupRequest } from "@shared/proto/cline/task_group"
import type { NotebookNoteMeta, TaskGroupThreadRow, TaskTag } from "@shared/task-groups"
import { CheckIcon, RotateCcwIcon } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { WroteNoteChip } from "@/components/chat/NotebookChangesRow"
import { ReadNoteChip } from "@/components/chat/NotebookToolRow"
import { HeaderIconButton } from "@/components/chat/task-header/HeaderIconButton"
import { InlineNotice } from "@/components/common/InlineNotice"
import { MENU_ICON_CLASS, MENU_ITEM_CLASS } from "@/components/common/menuStyles"
import { formatAge } from "@/components/inbox/inboxUtils"
import { SessionStatusIcon } from "@/components/inbox/SessionStatusIcon"
import { openTask, toggleTaskSettled } from "@/components/inbox/sessionActions"
import { isLiveThreadStatus, type ThreadStatus, threadStatusFor, threadStatusLabel } from "@/components/inbox/threadStatus"
import { useThreadStatuses } from "@/components/inbox/useThreadStatuses"
import { useNavigationHistory } from "@/components/navigation/NavigationHistoryContext"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { cn } from "@/lib/utils"
import { TaskGroupServiceClient } from "@/services/grpc-client"
import { dismissBranchHint, isBranchHintDismissed } from "./branchSuggestion"
import { getComposerPageTaskGroup, setComposerPageTaskGroup } from "./composerTaskGroup"
import { useSettleAll } from "./settleAll"
import { TaskGroupPageHeader } from "./TaskGroupPageHeader"
import { sameTag, TaskTagEditor } from "./TaskTagEditor"
import { formatNoteSize, openNote, requestNewNoteForm, threadRowTitle, useTaskGroup } from "./useTaskGroup"

/** How many notes the notebook preview grid shows. */
const NOTE_PREVIEW_COUNT = 4

const SECTION_HEADER_CLASS =
	"flex items-center gap-1.5 px-2 pt-2.5 pb-1 text-[10.5px] font-medium uppercase tracking-wider text-description"

const LINK_CLASS =
	"cursor-pointer border-0 bg-transparent p-0 text-[11px] normal-case tracking-normal text-link hover:text-link-hover focus-visible:outline focus-visible:outline-1 focus-visible:outline-(--vscode-focusBorder)"

const INPUT_CLASS =
	"min-w-0 rounded-xs border border-(--vscode-focusBorder) bg-input-background px-1.5 text-input-foreground outline-none placeholder:text-input-placeholder"

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`

export interface TimelineEntry {
	thread: TaskGroupThreadRow
	/** 0 for a thread, 1+ for a subthread (aside) nested under a listed parent. */
	depth: number
}

/**
 * The task's story: threads oldest-created first, each followed by its
 * subthreads (also oldest first). Subagents belong to their root thread and
 * aren't listed; a subthread whose parent isn't listed here is a thread.
 */
export function orderTimeline(threads: readonly TaskGroupThreadRow[]): TimelineEntry[] {
	const listed = threads.filter((thread) => !thread.isSubagent)
	const ids = new Set(listed.map((thread) => thread.threadId))
	const byStart = (a: TaskGroupThreadRow, b: TaskGroupThreadRow) => a.startedTs - b.startedTs || a.ts - b.ts
	const children = new Map<string, TaskGroupThreadRow[]>()
	const roots: TaskGroupThreadRow[] = []
	for (const thread of listed) {
		const parent = thread.parentTaskId
		if (parent && parent !== thread.threadId && ids.has(parent)) {
			children.set(parent, [...(children.get(parent) ?? []), thread])
		} else {
			roots.push(thread)
		}
	}
	const entries: TimelineEntry[] = []
	const seen = new Set<string>()
	const visit = (thread: TaskGroupThreadRow, depth: number) => {
		if (seen.has(thread.threadId)) return
		seen.add(thread.threadId)
		entries.push({ thread, depth })
		for (const child of (children.get(thread.threadId) ?? []).sort(byStart)) visit(child, depth + 1)
	}
	for (const thread of roots.sort(byStart)) visit(thread, 0)
	// A parent cycle has no root; list what's left rather than dropping it.
	for (const thread of [...listed].sort(byStart)) visit(thread, 0)
	return entries
}

interface TaskGroupViewProps {
	taskGroupId: string
	now?: number
}

/**
 * The task (group) page in the sidebar: title, tags and branch hint, a grid of
 * the newest notes, and the thread timeline (oldest first, like a story). The
 * chat composer below it starts new threads in this task.
 */
export const TaskGroupView = ({ taskGroupId, now = Date.now() }: TaskGroupViewProps) => {
	const { currentBranch, hideTaskGroupView, navigateToTaskGroup, taskHistory } = useExtensionState()
	const navigation = useNavigationHistory()
	// Bumped on dismiss so the hint (read from storage) re-renders away.
	const [, setBranchHintDismissals] = useState(0)
	const threadStatuses = useThreadStatuses()
	const { details, missing, refresh, setDetails } = useTaskGroup(taskGroupId)
	const [menuOpen, setMenuOpen] = useState(false)
	const [confirmingDelete, setConfirmingDelete] = useState(false)
	// Bumped by ⋯ › Rename task to start renaming in the breadcrumb.
	const [renameSignal, setRenameSignal] = useState(0)
	const renameFromMenu = useRef(false)
	const settleAll = useSettleAll(taskGroupId)

	// The composer below starts threads in this task, however many are sent.
	useEffect(() => {
		setComposerPageTaskGroup(taskGroupId)
		return () => {
			if (getComposerPageTaskGroup() === taskGroupId) setComposerPageTaskGroup(undefined)
		}
	}, [taskGroupId])

	const notes = useMemo(() => [...(details?.notes ?? [])].sort((a, b) => b.updatedAt - a.updatedAt), [details?.notes])
	const timeline = useMemo(() => orderTimeline(details?.threads ?? []), [details?.threads])
	const threadCount = timeline.length
	const noteNames = useMemo(() => new Map(notes.map((note) => [note.slug, note.name])), [notes])
	const settledIds = useMemo(
		() => new Set((taskHistory ?? []).filter((item) => item.isSettled).map((item) => item.id)),
		[taskHistory],
	)

	if (missing) {
		return (
			<div className="flex flex-1 flex-col overflow-hidden" data-testid="task-group-view">
				<TaskGroupPageHeader taskGroupId={taskGroupId} title="Task" />
				<div className="flex flex-col items-start gap-2 px-4 py-3 text-sm text-description">
					<span>This task no longer exists.</span>
					<Button onClick={hideTaskGroupView} size="sm" variant="secondary">
						Back home
					</Button>
				</div>
			</div>
		)
	}
	if (!details) {
		return (
			<div className="flex flex-1 flex-col overflow-hidden" data-testid="task-group-view">
				<TaskGroupPageHeader taskGroupId={taskGroupId} title="Task" />
			</div>
		)
	}

	const { group } = details

	const update = (patch: { title?: string; tags?: TaskTag[] }) => {
		setDetails((current) => (current ? { ...current, group: { ...current.group, ...patch } } : current))
		TaskGroupServiceClient.updateTaskGroup(
			UpdateTaskGroupRequest.create({
				id: group.id,
				title: patch.title,
				tags: patch.tags ? TaskTagList.create({ tags: patch.tags }) : undefined,
			}),
		)
			.catch((error) => console.error("Failed to update task:", error))
			.finally(refresh)
	}
	const rename = (title: string) => {
		const next = title.trim().replace(/\s+/g, " ")
		if (next && next !== group.title) update({ title: next })
	}
	const addTag = (tag: Pick<TaskTag, "kind" | "value">) => {
		if (group.tags.some((other) => sameTag(other, tag))) return
		update({ tags: [...group.tags, { ...tag, source: "user" }] })
	}
	const removeTag = (tag: TaskTag) => update({ tags: group.tags.filter((other) => other !== tag) })
	const deleteGroup = () => {
		setConfirmingDelete(false)
		TaskGroupServiceClient.deleteTaskGroup(DeleteTaskGroupRequest.create({ id: group.id }))
			.then(hideTaskGroupView)
			.catch((error) => console.error("Failed to delete task:", error))
	}

	const branchLinked = !currentBranch || group.tags.some((tag) => sameTag(tag, { kind: "branch", value: currentBranch }))

	return (
		<div className="flex flex-1 flex-col overflow-hidden" data-testid="task-group-view">
			<TaskGroupPageHeader onRename={rename} renameSignal={renameSignal} taskGroupId={group.id} title={group.title}>
				<Popover onOpenChange={setMenuOpen} open={menuOpen}>
					<PopoverTrigger asChild>
						<HeaderIconButton icon="ellipsis" label="Task actions" />
					</PopoverTrigger>
					<PopoverContent
						align="end"
						className="w-48 p-1 motion-reduce:animate-none"
						// Rename moves focus into the breadcrumb; returning it to ⋯ would end the rename at once.
						onCloseAutoFocus={(event) => {
							if (renameFromMenu.current) {
								renameFromMenu.current = false
								event.preventDefault()
							}
						}}
						side="bottom">
						<div className="flex flex-col" role="menu">
							<button
								className={MENU_ITEM_CLASS}
								onClick={() => {
									renameFromMenu.current = true
									setMenuOpen(false)
									setRenameSignal((count) => count + 1)
								}}
								role="menuitem"
								type="button">
								<span aria-hidden className="codicon codicon-edit text-[13px]" />
								Rename task
							</button>
							<button
								className={MENU_ITEM_CLASS}
								disabled={settleAll.disabled}
								onClick={() => {
									setMenuOpen(false)
									void settleAll.run()
								}}
								role="menuitem"
								type="button">
								<span
									aria-hidden
									className={cn(
										MENU_ICON_CLASS,
										settleAll.plan.mode === "settle" ? "codicon-check-all" : "codicon-discard",
									)}
								/>
								{settleAll.plan.mode === "settle" ? "Settle all" : "Unsettle all"}
							</button>
							<button
								className={cn(MENU_ITEM_CLASS, "text-error")}
								onClick={() => {
									setMenuOpen(false)
									setConfirmingDelete(true)
								}}
								role="menuitem"
								type="button">
								<span aria-hidden className="codicon codicon-trash text-[13px]" />
								Delete task…
							</button>
						</div>
					</PopoverContent>
				</Popover>
			</TaskGroupPageHeader>
			{settleAll.message && (
				<InlineNotice
					actions={
						<Button onClick={settleAll.dismiss} size="xs" variant="secondary">
							Dismiss
						</Button>
					}
					className="mx-4 mb-1"
					data-testid="task-group-settle-notice"
					tone={settleAll.message.partial ? "warning" : "info"}>
					{settleAll.message.text}
				</InlineNotice>
			)}
			{confirmingDelete && (
				<div
					className="mx-4 mb-1 flex flex-wrap items-center gap-2 rounded-xs border border-error/50 bg-error/10 px-2 py-1.5 text-xs"
					data-testid="task-group-delete-confirm"
					role="alert">
					<span className="min-w-0 flex-1">
						Delete this task? Its {plural(threadCount, "thread")} stay, just unfiled. Notes are deleted.
					</span>
					<Button onClick={deleteGroup} size="xs" variant="danger">
						Delete
					</Button>
					<Button onClick={() => setConfirmingDelete(false)} size="xs" variant="secondary">
						Cancel
					</Button>
				</div>
			)}
			<div className="flex-1 overflow-y-auto pb-2">
				{/* The name is in the breadcrumb (like a thread's); under it, just the tags and counts. */}
				<div className="flex min-w-0 items-start gap-2 px-4 pt-1 pb-2">
					<TaskTagEditor className="min-w-0 flex-1" onAdd={addTag} onRemove={removeTag} tags={group.tags} />
					<span className="shrink-0 text-[11px] leading-4 text-description" data-testid="task-group-counts">
						{plural(threadCount, "thread")} · {plural(notes.length, "note")}
					</span>
				</div>
				{!branchLinked && currentBranch && !isBranchHintDismissed(group.id, currentBranch) && (
					<div
						className="mx-4 mb-2 flex items-center gap-1.5 rounded-xs border border-dashed border-(--vscode-charts-green)/50 px-2 py-1 text-[11px] text-(--vscode-charts-green)"
						data-testid="task-group-branch-hint">
						<span aria-hidden className="codicon codicon-git-branch text-[12px]" />
						<span className="min-w-0 flex-1 truncate">
							Current branch <code className="text-[11px]">{currentBranch}</code> isn’t linked
						</span>
						<Button onClick={() => addTag({ kind: "branch", value: currentBranch })} size="xs" variant="secondary">
							Link branch
						</Button>
						<button
							aria-label={`Dismiss: don't suggest linking ${currentBranch} to this task`}
							className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-xs border-0 bg-transparent p-0 text-description hover:bg-list-hover hover:text-foreground"
							data-testid="task-group-branch-hint-dismiss"
							onClick={() => {
								dismissBranchHint(group.id, currentBranch)
								setBranchHintDismissals((count) => count + 1)
							}}
							title="Dismiss"
							type="button">
							<span aria-hidden className="codicon codicon-close text-[12px]" />
						</button>
					</div>
				)}
				<section className="px-2">
					<div className={SECTION_HEADER_CLASS}>
						<span aria-hidden className="codicon codicon-book text-[12px] text-(--vscode-charts-purple)" />
						Notebook · {notes.length}
						<span className="ml-auto flex items-center gap-2.5">
							<button
								className={LINK_CLASS}
								onClick={() => {
									requestNewNoteForm()
									navigateToTaskGroup(group.id, "notebook")
								}}
								type="button">
								＋ New
							</button>
							<button
								className={LINK_CLASS}
								onClick={() => navigateToTaskGroup(group.id, "notebook")}
								type="button">
								View all ›
							</button>
						</span>
					</div>
					{notes.length === 0 ? (
						<div className="px-2 pb-1 text-xs text-description">
							No notes yet. Threads in this task write notes as they learn things.
						</div>
					) : (
						<div className="grid grid-cols-2 gap-1.5 px-1" data-testid="task-group-note-grid">
							{notes.slice(0, NOTE_PREVIEW_COUNT).map((note) => (
								<NoteCard key={note.slug} note={note} onOpen={() => openNote(group.id, note.slug)} />
							))}
						</div>
					)}
				</section>
				<section className="mt-1 px-2">
					<div className={SECTION_HEADER_CLASS}>
						Timeline
						<span className="ml-auto flex items-center gap-1" data-testid="task-group-legend">
							<span
								aria-label="Wrote"
								className="inline-flex h-4 items-center rounded-xs border border-[color-mix(in_srgb,var(--vscode-charts-purple)_45%,transparent)] bg-[color-mix(in_srgb,var(--vscode-charts-purple)_15%,transparent)] px-1"
								role="img"
								title="Wrote">
								<i aria-hidden className="codicon codicon-edit text-[10px]! normal-case" />
							</span>
							<span
								aria-label="Read"
								className="inline-flex h-4 items-center rounded-xs border border-dashed border-description/60 px-1"
								role="img"
								title="Read">
								<i aria-hidden className="codicon codicon-eye text-[10px]! normal-case" />
							</span>
						</span>
					</div>
					{timeline.length === 0 ? (
						<div className="px-2 pb-1 text-xs text-description">No threads yet. Start one below.</div>
					) : (
						<ol className="m-0 list-none p-0" data-testid="task-group-timeline">
							{timeline.map(({ thread, depth }, index) => {
								const status = threadStatusFor(threadStatuses, thread.threadId)
								return (
									<TimelineRow
										first={index === 0}
										key={thread.threadId}
										last={index === timeline.length - 1}
										noteNames={noteNames}
										now={now}
										onOpen={() => {
											// Through the history layer, so Back returns here, not to the home screen
											// the task page briefly passes through while the thread opens.
											if (navigation) {
												navigation.navigate({ kind: "thread", id: thread.threadId })
												return
											}
											hideTaskGroupView()
											void openTask(thread.threadId)
										}}
										// A live thread is never shown as settled, even if the history flag lags.
										settled={settledIds.has(thread.threadId) && !isLiveThreadStatus(status)}
										status={status}
										statusLabel={threadStatusLabel(threadStatuses[thread.threadId])}
										subthread={depth > 0}
										thread={thread}
									/>
								)
							})}
						</ol>
					)}
				</section>
			</div>
		</div>
	)
}

function NoteCard({ note, onOpen }: { note: NotebookNoteMeta; onOpen: () => void }) {
	return (
		<button
			className="flex min-w-0 cursor-pointer flex-col gap-0.5 rounded-sm border border-[color-mix(in_srgb,var(--vscode-charts-purple)_30%,transparent)] bg-[color-mix(in_srgb,var(--vscode-charts-purple)_6%,transparent)] px-2 py-1.5 text-left transition-colors duration-150 hover:border-[color-mix(in_srgb,var(--vscode-charts-purple)_60%,transparent)] focus-visible:outline focus-visible:outline-1 focus-visible:outline-(--vscode-focusBorder) motion-reduce:transition-none"
			data-testid="task-group-note-card"
			onClick={onOpen}
			title={`Open ${note.name}`}
			type="button">
			<span className="flex w-full min-w-0 items-center gap-1">
				<span className="min-w-0 flex-1 truncate text-xs font-semibold text-foreground">{note.name}</span>
				<span className="shrink-0 text-[10.5px] text-description">{formatNoteSize(note.size)}</span>
			</span>
			<span className="w-full truncate text-[11px] text-description">{note.description || " "}</span>
		</button>
	)
}

/**
 * Connector geometry: node centers sit at (16px, 15px) of each row — the row's 1px border and 8px
 * padding put the 14px node column's center at x=16, and the 20px title line's center at y=15. The
 * spine is 2px wide on whole pixels (15–17) so it stays centered and crisp at any zoom, and stops
 * 2px short of each node so a dimmed (settled) node never shows the line through it.
 */
const SPINE_CLASS = "pointer-events-none absolute left-[15px] w-[2px] rounded-full bg-description/30"
const NODE_CENTER_Y = 15
const SPINE_GAP = 2

/**
 * One timeline entry. The spine is drawn per row (above and below the node,
 * never past the first or last one) so it reads as one continuous line; a
 * subthread branches off it with an elbow into a smaller node.
 */
function TimelineRow({
	thread,
	status,
	statusLabel,
	noteNames,
	now,
	onOpen,
	first,
	last,
	subthread,
	settled,
}: {
	thread: TaskGroupThreadRow
	status: ThreadStatus
	/** Settled threads dim; any thread or aside can be settled or unsettled from its row. */
	settled: boolean
	/** Tooltip for "waiting on subagents" ("Waiting on 2 subagents"). */
	statusLabel?: string
	noteNames: Map<string, string>
	now: number
	onOpen: () => void
	first: boolean
	last: boolean
	subthread: boolean
}) {
	const title = threadRowTitle(thread)
	const started = formatAge(thread.startedTs, now)
	const active = formatAge(thread.ts, now)
	const describeAge = (age: string) => (age === "now" ? "just now" : `${age} ago`)
	// Icons (spinner, hourglass) need more room than a dot.
	const iconStatus = status === "running" || status === "subagents"
	// Half the node's size (12px icon, 10px dot) plus the gap: where the spine stops above and below.
	const reach = (iconStatus ? 6 : 5) + SPINE_GAP
	return (
		<li
			className="group relative"
			data-settled={settled || undefined}
			data-subthread={subthread || undefined}
			data-testid="task-group-timeline-entry">
			<button
				className={cn(
					"relative grid w-full cursor-pointer gap-x-2 rounded-xs border border-transparent bg-transparent px-2 py-1 text-left transition-colors duration-150 hover:border-editor-group-border hover:bg-list-hover focus-visible:outline focus-visible:outline-1 focus-visible:outline-(--vscode-focusBorder) motion-reduce:transition-none",
					subthread ? "grid-cols-[28px_minmax(0,1fr)]" : "grid-cols-[14px_minmax(0,1fr)]",
					settled && "opacity-55 hover:opacity-90",
				)}
				data-testid="task-group-timeline-row"
				onClick={onOpen}
				title={`Started ${describeAge(started)} · last active ${describeAge(active)}`}
				type="button">
				<span className={cn("flex h-5 items-center", subthread ? "justify-end" : "justify-center")}>
					<span className="flex w-3 items-center justify-center" data-testid="task-group-timeline-node">
						<SessionStatusIcon
							className={subthread ? (iconStatus ? "size-2.5" : "size-1.5") : iconStatus ? "size-3" : "size-2.5"}
							label={statusLabel}
							status={status}
						/>
					</span>
				</span>
				<span className="flex min-w-0 items-center gap-1.5">
					<span
						className={cn(
							"ph-no-capture min-w-0 flex-1 truncate text-foreground",
							subthread ? "text-[12px]" : "text-[13px]",
						)}
						title={title}>
						{subthread && <span className="sr-only">Subthread: </span>}
						{title}
					</span>
					{/* Hover swaps the start time for Settle. */}
					<span
						className={cn(
							"shrink-0 text-right text-[10.5px] text-description",
							// On hover the slot widens to the button's size, so the title truncates before it.
							"transition-opacity duration-150 group-hover:min-w-16 group-hover:opacity-0 group-focus-within:min-w-16 group-focus-within:opacity-0 motion-reduce:transition-none",
						)}>
						{started}
					</span>
				</span>
				{(thread.wrote.length > 0 || thread.read.length > 0) && (
					<span className="col-start-2 mt-0.5 flex min-w-0 flex-wrap gap-1">
						{thread.wrote.map((slug) => (
							<WroteNoteChip key={`w:${slug}`} name={noteNames.get(slug) ?? slug} />
						))}
						{thread.read.map((slug) => (
							<ReadNoteChip key={`r:${slug}`} name={noteNames.get(slug) ?? slug} />
						))}
					</span>
				)}
			</button>
			<button
				aria-label={settled ? `Unsettle ${title}` : `Settle ${title}`}
				className={cn(
					"absolute top-1 right-2 flex h-4.5 cursor-pointer items-center gap-1 whitespace-nowrap rounded-xs border border-editor-group-border bg-button-secondary-background px-1.5 text-[10px] text-button-secondary-foreground",
					"opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-visible:opacity-100 group-focus-within:opacity-100 hover:bg-button-secondary-background-hover motion-reduce:transition-none",
				)}
				data-testid="task-group-timeline-settle"
				onClick={() => void toggleTaskSettled(thread.threadId)}
				type="button">
				{settled ? <RotateCcwIcon className="size-2.5" /> : <CheckIcon className="size-2.5" />}
				{settled ? "Unsettle" : "Settle"}
			</button>
			{/* After the button so a hovered row's background doesn't hide the line. */}
			{subthread ? (
				<>
					{/* Elbow from the spine into the subthread's node; the spine carries on past it. */}
					<span
						aria-hidden
						className="pointer-events-none absolute top-0 left-[15px] h-[16px] w-[9px] rounded-bl-[6px] border-x-0 border-t-0 border-b-2 border-l-2 border-solid border-description/30"
					/>
					{!last && <span aria-hidden className={cn(SPINE_CLASS, "bottom-0")} style={{ top: NODE_CENTER_Y }} />}
				</>
			) : (
				<>
					{!first && (
						<span aria-hidden className={cn(SPINE_CLASS, "top-0")} style={{ height: NODE_CENTER_Y - reach }} />
					)}
					{!last && <span aria-hidden className={cn(SPINE_CLASS, "bottom-0")} style={{ top: NODE_CENTER_Y + reach }} />}
				</>
			)}
		</li>
	)
}
