import { AnimatePresence, motion } from "framer-motion"
import { CheckIcon, RotateCcwIcon } from "lucide-react"
import { Fragment, memo, useCallback, useEffect, useMemo, useState } from "react"
import { InlineNotice } from "@/components/common/InlineNotice"
import { type EffectiveTag, effectiveThreadTags } from "@/components/taskGroup/effectiveThreadTags"
import { useSettleAll } from "@/components/taskGroup/settleAll"
import { TaskTagChip } from "@/components/taskGroup/TaskTagChip"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useReducedMotionPreference } from "@/hooks/useReducedMotionPreference"
import { cn } from "@/lib/utils"
import {
	ACTIVE_PAGE_SIZE,
	buildInbox,
	DEFAULT_ACTIVE_LIMIT,
	DEFAULT_SETTLED_LIMIT,
	describeActivity,
	EXPANDED_TASK_GROUPS_EVENT,
	formatAge,
	formatStamp,
	GROUP_PREVIEW_COUNT,
	type InboxRow,
	type InboxTaskGroupRow,
	isRowWorking,
	readExpandedTaskGroups,
	SETTLED_PAGE_SIZE,
	writeExpandedTaskGroups,
} from "./inboxUtils"
import { SessionStatusIcon } from "./SessionStatusIcon"
import { openTask, toggleTaskSettled } from "./sessionActions"
import { TaskGroupRowMenu } from "./TaskGroupRowMenu"

interface CountBadgeProps {
	/** Codicon name without the `codicon-` prefix. */
	icon: string
	count: number
	tone: "idle" | "live" | "attention"
	title: string
}

export const CountBadge = ({ icon, count, tone, title }: CountBadgeProps) => (
	<span
		className={cn(
			"inline-flex h-4 items-center gap-0.5 text-[10.5px] leading-none tabular-nums transition-colors duration-200 motion-reduce:transition-none",
			tone === "attention" ? "text-warning" : tone === "live" ? "text-link" : "text-description",
		)}
		data-tone={tone}
		title={title}>
		<span aria-hidden className={`codicon codicon-${icon} text-[12px]`} />
		{count}
	</span>
)

interface InboxRowViewProps {
	row: InboxRow
	now: number
	animateLayout: boolean
	/** Tags to show: own plus the task's. Rows under a task row pass only their own. */
	tags: readonly EffectiveTag[]
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`

/** Most tag chips a row shows before folding the rest into "+N". */
const ROW_TAG_LIMIT = 2

/** A row's first tags as small chips (inherited ones muted), the rest as "+N" (all of them in its tooltip). */
const RowTagChips = ({ tags }: { tags: readonly EffectiveTag[] }) => {
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

const InboxRowView = ({ row, now, animateLayout, tags }: InboxRowViewProps) => {
	const {
		item,
		activityTs,
		status,
		settled,
		subthreadCount,
		liveSubthreadCount,
		subagentCount,
		liveSubagentCount,
		attentionSubagentCount,
	} = row
	const time = settled ? formatStamp(activityTs, now) : formatAge(activityTs, now)
	const activity = describeActivity(row, now)
	const subagentTitle = [
		plural(subagentCount, "subagent"),
		attentionSubagentCount ? `${attentionSubagentCount} need${attentionSubagentCount === 1 ? "s" : ""} you` : "",
		liveSubagentCount ? `${liveSubagentCount} running` : "",
	]
		.filter(Boolean)
		.join(", ")

	return (
		<motion.div
			className={cn(
				// Fixed height: every row is the same size whatever the chat holds.
				"group grid h-11 grid-cols-[14px_minmax(0,1fr)_auto] items-center gap-2 overflow-hidden rounded-xs border border-transparent px-2 cursor-pointer animate-row-in motion-reduce:animate-none",
				"hover:bg-list-hover hover:border-editor-group-border focus-visible:outline focus-visible:outline-1 focus-visible:outline-(--vscode-focusBorder)",
				settled && "opacity-55 hover:opacity-90",
			)}
			data-testid="inbox-row"
			layout={animateLayout ? "position" : false}
			onClick={() => void openTask(item.id)}
			onKeyDown={(event) => {
				if (event.key === "Enter" || event.key === " ") {
					event.preventDefault()
					void openTask(item.id)
				}
			}}
			role="button"
			tabIndex={0}
			transition={{ duration: 0.18, ease: "easeOut" }}>
			<div className="flex h-5 items-center justify-center self-start pt-1.5">
				<SessionStatusIcon label={status === "subagents" ? activity : undefined} settled={settled} status={status} />
			</div>
			<div className="min-w-0">
				<div className="ph-no-capture truncate text-sm text-foreground">{item.title || item.task}</div>
				<div className="flex min-w-0 items-center gap-1 overflow-hidden text-xs" data-testid="inbox-row-detail">
					<RowTagChips tags={tags} />
					<span
						className={cn(
							"min-w-0 truncate",
							status === "running" && !settled
								? "animate-shimmer bg-linear-90 from-foreground to-description bg-[length:200%_100%] bg-clip-text text-transparent motion-reduce:animate-none motion-reduce:text-description"
								: "text-description",
						)}>
						{activity}
					</span>
				</div>
			</div>
			<div className="flex items-center gap-2">
				{(subagentCount > 0 || subthreadCount > 0) && (
					<div className="flex items-center gap-1.5" data-testid="inbox-row-counts">
						{subagentCount > 0 && (
							<CountBadge
								count={subagentCount}
								icon="type-hierarchy-sub"
								title={subagentTitle}
								tone={attentionSubagentCount > 0 ? "attention" : liveSubagentCount > 0 ? "live" : "idle"}
							/>
						)}
						{subthreadCount > 0 && (
							<CountBadge
								count={subthreadCount}
								icon="repo-forked"
								title={`${plural(subthreadCount, "aside")}${liveSubthreadCount ? `, ${liveSubthreadCount} running` : ""}`}
								tone={liveSubthreadCount > 0 ? "live" : "idle"}
							/>
						)}
					</div>
				)}
				{/* The time and the settle action share one slot: hover swaps them, so no blank space is reserved. */}
				<div className="relative flex h-4.5 min-w-11 items-center justify-end">
					<span className="text-[10px] text-description transition-opacity duration-150 group-hover:opacity-0 group-focus-within:opacity-0 motion-reduce:transition-none">
						{time}
					</span>
					<button
						aria-label={settled ? `Unsettle ${item.title || item.task}` : `Settle ${item.title || item.task}`}
						className={cn(
							"absolute right-0 top-0 flex h-4.5 items-center gap-1 whitespace-nowrap rounded-xs border border-editor-group-border bg-button-secondary-background px-1.5 text-[10px] text-button-secondary-foreground",
							"opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-visible:opacity-100 group-focus-within:opacity-100 hover:bg-button-secondary-background-hover motion-reduce:transition-none",
						)}
						onClick={(event) => {
							event.stopPropagation()
							void toggleTaskSettled(item.id)
						}}
						type="button">
						{settled ? <RotateCcwIcon className="size-2.5" /> : <CheckIcon className="size-2.5" />}
						{settled ? "Unsettle" : "Settle"}
					</button>
				</div>
			</div>
		</motion.div>
	)
}

interface TaskGroupRowViewProps {
	row: InboxTaskGroupRow
	now: number
	expanded: boolean
	onToggle: () => void
	onOpen?: (taskGroupId: string) => void
	animateLayout: boolean
	/** Listed under Settled: every thread is settled, or it has none. */
	settled?: boolean
}

/** A task group row: chevron, title + tags, thread count, newest activity, running count. */
const TaskGroupRowView = ({ row, now, expanded, onToggle, onOpen, animateLayout, settled = false }: TaskGroupRowViewProps) => {
	const { group, members, activityTs, runningCount } = row
	// Every member shows once expanded past the preview, so any thread can be settled from home.
	const [showAll, setShowAll] = useState(false)
	const shown = showAll ? members : members.slice(0, GROUP_PREVIEW_COUNT)
	const more = members.length - shown.length
	const firstSettled = shown.findIndex((member) => member.settled && !isRowWorking(member))
	const open = () => onOpen?.(group.id)
	const settleAll = useSettleAll(group.id)
	const [menuOpen, setMenuOpen] = useState(false)

	return (
		<div data-testid="inbox-task-group">
			<div
				className={cn(
					"group grid h-11 grid-cols-[14px_minmax(0,1fr)_auto] items-center gap-2 overflow-hidden rounded-xs border border-transparent px-2 cursor-pointer animate-row-in motion-reduce:animate-none",
					"hover:bg-list-hover hover:border-editor-group-border focus-visible:outline focus-visible:outline-1 focus-visible:outline-(--vscode-focusBorder)",
					settled && "opacity-55 hover:opacity-90",
				)}
				data-settled={settled || undefined}
				data-testid="inbox-task-group-row"
				onClick={open}
				onKeyDown={(event) => {
					if (event.key === "Enter" || event.key === " ") {
						event.preventDefault()
						open()
					}
				}}
				role="button"
				tabIndex={0}>
				<button
					aria-expanded={expanded}
					aria-label={`${expanded ? "Collapse" : "Expand"} ${group.title}`}
					className="flex h-5 w-3.5 cursor-pointer items-center justify-center self-start border-0 bg-transparent p-0 pt-1.5 text-description hover:text-foreground"
					onClick={(event) => {
						event.stopPropagation()
						onToggle()
					}}
					type="button">
					<span
						className={cn(
							"codicon codicon-chevron-down text-[12px] transition-transform duration-150 motion-reduce:transition-none",
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
						<span className="ph-no-capture truncate font-medium">{group.title}</span>
					</div>
					<div className="flex min-w-0 items-center gap-1 overflow-hidden text-xs text-description">
						<RowTagChips tags={group.tags.map((tag) => ({ tag, inherited: false }))} />
						<span className="shrink-0 whitespace-nowrap">
							{group.tags.length > 0 && "· "}
							{plural(members.length, "thread")}
						</span>
					</div>
				</div>
				<div className="relative flex min-w-11 flex-col items-end gap-0.5">
					{/* The time and the ⋯ menu share one slot: hover swaps them. */}
					<span
						className={cn(
							"text-[10px] leading-[18px] text-description transition-opacity duration-150 group-hover:opacity-0 group-focus-within:opacity-0 motion-reduce:transition-none",
							menuOpen && "opacity-0",
						)}>
						{settled ? formatStamp(activityTs, now) : formatAge(activityTs, now)}
					</span>
					<TaskGroupRowMenu onOpenChange={setMenuOpen} settleAll={settleAll} title={group.title} />
					{runningCount > 0 && (
						<span className="text-[10px] text-link" data-testid="inbox-task-group-running">
							{runningCount} running
						</span>
					)}
				</div>
			</div>
			{settleAll.message && (
				<InlineNotice
					actions={
						<button
							className="cursor-pointer border-0 bg-transparent p-0 text-xs text-link hover:text-link-hover"
							onClick={settleAll.dismiss}
							type="button">
							Dismiss
						</button>
					}
					className="mx-2 mb-1"
					data-testid="inbox-task-group-settle-notice"
					tone={settleAll.message.partial ? "warning" : "info"}>
					{settleAll.message.text}
				</InlineNotice>
			)}
			{expanded && (
				<div className="ml-3.5 border-l border-editor-group-border pl-1" data-testid="inbox-task-group-members">
					{shown.map((member, index) => (
						<Fragment key={member.item.id}>
							{/* Active threads come first; a quiet divider starts the settled ones. */}
							{index === firstSettled && index > 0 && (
								<div
									className="flex h-5 items-center gap-1.5 px-2 text-[10px] uppercase tracking-wider text-description"
									data-testid="inbox-task-group-settled-divider">
									Settled
									<span aria-hidden className="h-px flex-1 bg-editor-group-border" />
								</div>
							)}
							<InboxRowView
								animateLayout={animateLayout}
								now={now}
								row={member}
								// The task row above already shows the task's tags, so members list only their own.
								tags={(member.item.tags ?? []).map((tag) => ({ tag, inherited: false }))}
							/>
						</Fragment>
					))}
					<div className="flex h-6 items-center gap-2 px-2 text-xs text-description">
						{members.length > GROUP_PREVIEW_COUNT ? (
							<button
								aria-expanded={showAll}
								className="cursor-pointer border-0 bg-transparent p-0 text-xs text-description hover:text-foreground"
								data-testid="inbox-task-group-more"
								onClick={() => setShowAll(!showAll)}
								type="button">
								{showAll ? "Show fewer" : `Show ${more} more`}
							</button>
						) : (
							members.length === 0 && <span>No threads yet</span>
						)}
						<button
							className="ml-auto cursor-pointer border-0 bg-transparent p-0 text-xs text-link hover:text-link-hover"
							onClick={open}
							type="button">
							Open task ›
						</button>
					</div>
				</div>
			)}
		</div>
	)
}

const SETTLED_COLLAPSED_KEY = "inbox.settledCollapsed"

function readCollapsed(): boolean {
	try {
		return localStorage.getItem(SETTLED_COLLAPSED_KEY) === "1"
	} catch {
		return false
	}
}

interface InboxListProps {
	showHistoryView: () => void
	/** Opens a task group's page (group row click and "Open task ›"). */
	onOpenTaskGroup?: (taskGroupId: string) => void
	/** Clock override for tests. */
	now?: number
}

/**
 * Home inbox: active (unsettled) chats and tasks on top by recency; settled
 * chats and fully settled (or empty) tasks below.
 * Status comes from the host's live `sessionStatuses`; asides are folded into
 * their parent's subthread count.
 */
const InboxList = ({ showHistoryView, onOpenTaskGroup, now = Date.now() }: InboxListProps) => {
	const { taskHistory, sessionStatuses, subagentCounts, taskGroups } = useExtensionState()
	const reduceMotion = useReducedMotionPreference()
	const [activeLimit, setActiveLimit] = useState(DEFAULT_ACTIVE_LIMIT)
	const [settledLimit, setSettledLimit] = useState(DEFAULT_SETTLED_LIMIT)
	const [settledCollapsed, setSettledCollapsed] = useState(readCollapsed)
	const [expandedGroups, setExpandedGroups] = useState(readExpandedTaskGroups)
	const { activeEntries, settled, settledTotal, hiddenCount } = useMemo(
		() => buildInbox(taskHistory ?? [], sessionStatuses, subagentCounts, { activeLimit, settledLimit, taskGroups }),
		[taskHistory, sessionStatuses, subagentCounts, activeLimit, settledLimit, taskGroups],
	)
	// A group created elsewhere (the new-task sheet) opens expanded.
	useEffect(() => {
		const sync = () => setExpandedGroups(readExpandedTaskGroups())
		window.addEventListener(EXPANDED_TASK_GROUPS_EVENT, sync)
		return () => window.removeEventListener(EXPANDED_TASK_GROUPS_EVENT, sync)
	}, [])
	const toggleGroup = useCallback((id: string) => {
		setExpandedGroups((current) => {
			const next = new Set(current)
			if (!next.delete(id)) next.add(id)
			writeExpandedTaskGroups(next)
			return next
		})
	}, [])
	const toggleSettledCollapsed = useCallback(() => {
		setSettledCollapsed((collapsed) => {
			try {
				localStorage.setItem(SETTLED_COLLAPSED_KEY, collapsed ? "0" : "1")
			} catch {
				// Persistence is best-effort; the toggle still works for this session.
			}
			return !collapsed
		})
	}, [])

	if (activeEntries.length === 0 && settledTotal === 0) {
		return null
	}

	const sectionClass =
		"flex items-center gap-1.5 px-2 pt-2.5 pb-1 text-[10.5px] font-medium uppercase tracking-wider text-description"

	const moreClass = "border-0 bg-transparent p-0 text-xs text-description hover:text-foreground cursor-pointer"

	return (
		<div className="shrink-0 px-3" data-testid="inbox-list">
			<div className={sectionClass}>
				<span>Active</span>
				<span className="opacity-70">{activeEntries.length}</span>
				<button
					aria-label="View all history"
					className="ml-auto flex items-center gap-0.5 border-0 bg-transparent p-0 text-[10.5px] normal-case tracking-normal text-description hover:text-foreground cursor-pointer"
					onClick={showHistoryView}
					type="button">
					View all history
					<span className="codicon codicon-chevron-right text-[12px]" />
				</button>
			</div>
			{activeEntries.length > 0 ? (
				activeEntries.map((entry) =>
					entry.kind === "group" ? (
						<TaskGroupRowView
							animateLayout={!reduceMotion}
							expanded={expandedGroups.has(entry.row.group.id)}
							key={`group:${entry.row.group.id}`}
							now={now}
							onOpen={onOpenTaskGroup}
							onToggle={() => toggleGroup(entry.row.group.id)}
							row={entry.row}
						/>
					) : (
						<InboxRowView
							animateLayout={!reduceMotion}
							key={entry.row.item.id}
							now={now}
							row={entry.row}
							tags={effectiveThreadTags(entry.row.item, taskHistory, taskGroups)}
						/>
					),
				)
			) : (
				<div className="px-2 py-1.5 text-xs text-description">Nothing active.</div>
			)}
			{settledTotal > 0 && (
				<>
					<button
						aria-expanded={!settledCollapsed}
						aria-label={`${settledCollapsed ? "Expand" : "Collapse"} settled chats`}
						className={cn(
							sectionClass,
							"w-full cursor-pointer border-0 bg-transparent text-left hover:text-foreground",
						)}
						onClick={toggleSettledCollapsed}
						type="button">
						<span
							className={cn(
								"codicon codicon-chevron-down text-[12px] transition-transform duration-150 motion-reduce:transition-none",
								settledCollapsed && "-rotate-90",
							)}
						/>
						<span>Settled</span>
						<span className="opacity-70">{settledTotal}</span>
					</button>
					<AnimatePresence initial={false}>
						{!settledCollapsed && (
							<motion.div
								animate={reduceMotion ? undefined : { height: "auto", opacity: 1 }}
								exit={reduceMotion ? undefined : { height: 0, opacity: 0 }}
								initial={reduceMotion ? false : { height: 0, opacity: 0 }}
								key="settled-rows"
								style={{ overflow: "hidden" }}
								transition={{ duration: 0.18, ease: "easeOut" }}>
								{settled.map((entry) =>
									entry.kind === "group" ? (
										<TaskGroupRowView
											animateLayout={!reduceMotion}
											expanded={expandedGroups.has(entry.row.group.id)}
											key={`group:${entry.row.group.id}`}
											now={now}
											onOpen={onOpenTaskGroup}
											onToggle={() => toggleGroup(entry.row.group.id)}
											row={entry.row}
											settled
										/>
									) : (
										<InboxRowView
											animateLayout={!reduceMotion}
											key={entry.row.item.id}
											now={now}
											row={entry.row}
											tags={effectiveThreadTags(entry.row.item, taskHistory, taskGroups)}
										/>
									),
								)}
								{(settledTotal > settled.length || settledLimit > DEFAULT_SETTLED_LIMIT) && (
									<div className="flex gap-3 px-2 py-1">
										{settledTotal > settled.length && (
											<button
												className={moreClass}
												onClick={() => setSettledLimit((limit) => limit + SETTLED_PAGE_SIZE)}
												type="button">
												Show more ({settledTotal - settled.length})
											</button>
										)}
										{settledLimit > DEFAULT_SETTLED_LIMIT && (
											<button
												className={moreClass}
												onClick={() => setSettledLimit(DEFAULT_SETTLED_LIMIT)}
												type="button">
												Show fewer
											</button>
										)}
									</div>
								)}
							</motion.div>
						)}
					</AnimatePresence>
				</>
			)}
			{hiddenCount > 0 && (
				<button
					className="mt-1 w-full border-0 bg-transparent px-2 py-1 text-left text-xs text-description hover:text-foreground cursor-pointer"
					onClick={() => setActiveLimit((limit) => limit + ACTIVE_PAGE_SIZE)}
					type="button">
					Show more ({hiddenCount})
				</button>
			)}
		</div>
	)
}

export default memo(InboxList)
