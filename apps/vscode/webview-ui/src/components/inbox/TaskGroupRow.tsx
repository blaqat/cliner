import type { ReactNode } from "react"
import { InlineNotice } from "@/components/common/InlineNotice"
import type { EffectiveTag } from "@/components/taskGroup/effectiveThreadTags"
import { useTaskRowActions } from "@/components/taskGroup/settleAll"
import { TaskTagChip } from "@/components/taskGroup/TaskTagChip"
import { cn } from "@/lib/utils"
import { activityTitle, agentLaterAge, formatAge, formatStamp, type InboxTaskGroupRow } from "./inboxUtils"
import { MEMBER_INDENT_PX, SPINE_CLASS, TASK_SPINE_STYLE, treeRowStyle } from "./treeGeometry"

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`

/** Most tag chips a row shows before folding the rest into "+N". */
const ROW_TAG_LIMIT = 2

/** A row's first tags as small chips (inherited ones muted), the rest as "+N" (all of them in its tooltip). */
export const RowTagChips = ({ tags }: { tags: readonly EffectiveTag[] }) => {
	if (!tags.length) return null
	const hidden = tags.slice(ROW_TAG_LIMIT)
	return (
		<>
			{tags.slice(0, ROW_TAG_LIMIT).map(({ tag, inherited, taskTitle }) => (
				<TaskTagChip
					className="max-w-24"
					inheritedFrom={inherited ? (taskTitle ?? "task") : undefined}
					key={`${tag.kind}:${tag.value}`}
					kind={tag.kind}
					value={tag.value}
				/>
			))}
			{hidden.length > 0 && (
				<span
					className="shrink-0 text-[10.5px] text-description"
					data-testid="row-tag-overflow"
					title={hidden.map((entry) => entry.tag.value).join(", ")}>
					+{hidden.length}
				</span>
			)}
		</>
	)
}

export interface RowAction {
	/** Codicon name without the `codicon-` prefix. */
	icon: string
	/** Accessible name, e.g. "Stash Fix CRLF diffs". */
	label: string
	tooltip: string
	onClick: () => void
	disabled?: boolean
}

/** The row's time/meta: hidden while the row is hovered or focused, when the actions take its place. */
export const ROW_META_CLASS = "group-hover:hidden group-focus-within:hidden"

const ROW_ACTION_CLASS =
	"flex size-4.5 shrink-0 cursor-pointer items-center justify-center rounded-xs border-0 bg-transparent p-0 text-description hover:bg-toolbar-hover hover:text-foreground focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-(--vscode-focusBorder) disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"

/**
 * A row's Stash / Settle as small icon buttons with tooltips. They take the time's place on hover
 * or focus (in the layout, never over the text), so the title's ellipsis moves left to make room.
 * Focusing the row shows them, so Tab reaches them.
 */
export const RowActions = ({ actions, className }: { actions: readonly RowAction[]; className?: string }) => (
	// biome-ignore lint/a11y/noNoninteractiveElementInteractions: keeps Enter/Space on a button from also opening the row
	<span
		className={cn("hidden shrink-0 items-center gap-0.5 group-hover:flex group-focus-within:flex", className)}
		data-testid="row-actions"
		onKeyDown={(event) => event.stopPropagation()}>
		{actions.map((action) => (
			<button
				aria-label={action.label}
				className={ROW_ACTION_CLASS}
				disabled={action.disabled}
				key={action.icon}
				onClick={(event) => {
					event.stopPropagation()
					action.onClick()
				}}
				title={action.tooltip}
				type="button">
				<span aria-hidden className={`codicon codicon-${action.icon} text-[12px]!`} />
			</button>
		))}
	</span>
)

/** Stash / Unstash and Settle / Unsettle for one thread. */
export function threadRowActions(
	title: string,
	{ stashed, settled, onStash, onSettle }: { stashed: boolean; settled: boolean; onStash: () => void; onSettle: () => void },
): RowAction[] {
	return [
		{
			icon: stashed ? "inbox" : "archive",
			label: `${stashed ? "Unstash" : "Stash"} ${title}`,
			tooltip: stashed ? "Unstash" : "Stash",
			onClick: onStash,
		},
		{
			icon: settled ? "discard" : "check",
			label: `${settled ? "Unsettle" : "Settle"} ${title}`,
			tooltip: settled ? "Unsettle" : "Settle",
			onClick: onSettle,
		},
	]
}

export const TASK_ROW_CLASS =
	"group grid h-11 items-center gap-x-2 overflow-hidden rounded-xs border border-transparent cursor-pointer animate-row-in motion-reduce:animate-none hover:bg-list-hover hover:border-editor-group-border outline-none focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-(--vscode-focusBorder)"

interface TaskGroupRowProps {
	row: InboxTaskGroupRow
	now: number
	expanded: boolean
	onToggle: () => void
	onOpen: () => void
	/** Listed under Settled: every thread is settled, or it has none. */
	settled?: boolean
	/** The task's page is on screen (one view). */
	current?: boolean
	/** The title as shown (e.g. with search hits in bold); defaults to the plain title. */
	titleNode?: ReactNode
	testId?: string
	/** Extra attributes for the row element (one view's keyboard-nav marker, data ids). */
	rowAttrs?: Record<string, string | undefined>
}

/**
 * A task row, the same on the classic home inbox and in one view's list: fold chevron in the icon
 * column (the connector to its threads drops from its center), the task icon and title, its tags
 * and thread count, newest activity, and what's running or waiting. Hovering swaps the time for
 * Stash and Settle, which act on every thread in the task: the row moves to Stashed / Settled once
 * all its threads are, and Unstash / Unsettle bring them all back.
 */
export const TaskGroupRow = ({
	row,
	now,
	expanded,
	onToggle,
	onOpen,
	settled = false,
	current = false,
	titleNode,
	testId = "inbox-task-group-row",
	rowAttrs,
}: TaskGroupRowProps) => {
	const { group, members, activityTs, runningCount } = row
	const waitingCount = members.filter((member) => member.status === "waiting" && !member.settled).length
	const agentLater = settled ? undefined : agentLaterAge(row, now)
	const actions = useTaskRowActions(group.id)
	const stashing = actions.stash.plan.mode === "stash"
	const settling = actions.settle.plan.mode === "settle"
	const noThreads = "This task has no threads yet"

	return (
		<>
			<div
				{...rowAttrs}
				aria-current={current ? "page" : undefined}
				className={cn(TASK_ROW_CLASS, current && "bg-selection/40", settled && "opacity-55 hover:opacity-90")}
				data-current={current || undefined}
				data-settled={settled || undefined}
				data-task-id={group.id}
				data-testid={testId}
				onClick={onOpen}
				onKeyDown={(event) => {
					if (event.target !== event.currentTarget) return
					if (event.key === "Enter" || event.key === " ") {
						event.preventDefault()
						onOpen()
					}
				}}
				role="button"
				style={treeRowStyle()}
				tabIndex={0}>
				<button
					aria-expanded={expanded}
					aria-label={`${expanded ? "Collapse" : "Expand"} ${group.title}`}
					className="flex h-5 w-full cursor-pointer items-center justify-center self-start border-0 bg-transparent p-0 pt-1.5 text-description hover:text-foreground focus-visible:outline focus-visible:outline-1 focus-visible:outline-(--vscode-focusBorder)"
					data-testid="task-row-chevron"
					onClick={(event) => {
						event.stopPropagation()
						onToggle()
					}}
					type="button">
					<span
						aria-hidden
						className={cn(
							"codicon codicon-chevron-down text-[12px]! transition-transform duration-150 motion-reduce:transition-none",
							!expanded && "-rotate-90",
						)}
					/>
				</button>
				<div className="min-w-0">
					<div className="flex min-w-0 items-center gap-1 text-sm text-foreground">
						<span
							aria-hidden
							className="codicon codicon-tasklist shrink-0 text-[12px]! text-(--vscode-charts-purple)"
						/>
						<span className="ph-no-capture truncate font-medium">{titleNode ?? group.title}</span>
					</div>
					<div className="flex min-w-0 items-center gap-1 overflow-hidden text-xs text-description">
						<RowTagChips tags={group.tags.map((tag) => ({ tag, inherited: false }))} />
						<span className="shrink-0 whitespace-nowrap">
							{group.tags.length > 0 && "· "}
							{plural(members.length, "thread")}
						</span>
					</div>
				</div>
				<div className="flex min-w-11 flex-col items-end gap-0.5">
					{/* The time and the row actions share one slot: hover swaps them. */}
					<span
						className={cn("text-[10px] leading-[18px] text-description tabular-nums", ROW_META_CLASS)}
						data-testid="inbox-task-group-time"
						title={activityTitle(row, now)}>
						{settled ? formatStamp(activityTs, now) : formatAge(activityTs, now)}
					</span>
					<RowActions
						actions={[
							{
								icon: stashing ? "archive" : "inbox",
								label: `${stashing ? "Stash" : "Unstash"} ${group.title}`,
								tooltip: actions.stash.disabled
									? noThreads
									: stashing
										? "Stash every thread in this task"
										: "Unstash every thread in this task",
								onClick: () => void actions.stash.run(),
								disabled: actions.stash.disabled,
							},
							{
								icon: settling ? "check" : "discard",
								label: `${settling ? "Settle" : "Unsettle"} ${group.title}`,
								tooltip: actions.settle.disabled
									? noThreads
									: settling
										? "Settle every thread in this task (running ones stay open)"
										: "Unsettle every thread in this task",
								onClick: () => void actions.settle.run(),
								disabled: actions.settle.disabled,
							},
						]}
						className="h-[18px]"
					/>
					{waitingCount > 0 ? (
						<span className="text-[10px] text-warning" data-testid="inbox-task-group-waiting">
							{waitingCount} need{waitingCount === 1 ? "s" : ""} you
						</span>
					) : runningCount > 0 ? (
						<span className="text-[10px] text-link" data-testid="inbox-task-group-running">
							{runningCount} running
						</span>
					) : (
						agentLater && (
							// The task sorts by your last message; this says the agent has done more since.
							<span className="text-[10px] text-description/80" data-testid="inbox-task-group-agent">
								agent {agentLater}
							</span>
						)
					)}
				</div>
			</div>
			{actions.message && (
				<InlineNotice
					actions={
						<button
							className="cursor-pointer border-0 bg-transparent p-0 text-xs text-link hover:text-link-hover"
							onClick={actions.dismiss}
							type="button">
							Dismiss
						</button>
					}
					className="mr-2 mb-1"
					data-testid="inbox-task-group-settle-notice"
					style={{ marginLeft: MEMBER_INDENT_PX }}
					tone={actions.message.partial ? "warning" : "info"}>
					{actions.message.text}
				</InlineNotice>
			)}
		</>
	)
}

interface TaskGroupBlockProps {
	expanded: boolean
	/** Draw the connector (the task is expanded and lists something under it). */
	spine: boolean
	children: ReactNode
	testId?: string
}

/** A task row plus its threads; when expanded, the connector runs down the task's icon column. */
export const TaskGroupBlock = ({ expanded, spine, children, testId }: TaskGroupBlockProps) => (
	<div className="relative" data-expanded={expanded || undefined} data-testid={testId}>
		{children}
		{/* After the rows so a hovered row's background doesn't hide it. */}
		{expanded && spine && <span aria-hidden className={SPINE_CLASS} data-testid="task-spine" style={TASK_SPINE_STYLE} />}
	</div>
)

/** The threads under a task row, indented past the connector. */
export const TaskGroupMembers = ({ children, testId }: { children: ReactNode; testId?: string }) => (
	<div data-testid={testId} style={{ paddingLeft: MEMBER_INDENT_PX }}>
		{children}
	</div>
)
