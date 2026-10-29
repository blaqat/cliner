import { AnimatePresence, motion } from "framer-motion"
import { memo, useCallback, useEffect, useMemo, useState } from "react"
import { type EffectiveTag, effectiveThreadTags } from "@/components/taskGroup/effectiveThreadTags"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useReducedMotionPreference } from "@/hooks/useReducedMotionPreference"
import { cn } from "@/lib/utils"
import {
	ACTIVE_PAGE_SIZE,
	activityTitle,
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
	readExpandedTaskGroups,
	SETTLED_PAGE_SIZE,
	writeExpandedTaskGroups,
} from "./inboxUtils"
import { SessionStatusIcon } from "./SessionStatusIcon"
import { openTask, toggleTaskSettled, toggleTaskStashed } from "./sessionActions"
import {
	ROW_META_CLASS,
	RowActions,
	RowTagChips,
	TaskGroupBlock,
	TaskGroupMembers,
	TaskGroupRow,
	threadRowActions,
} from "./TaskGroupRow"
import { treeRowStyle } from "./treeGeometry"

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
				"group grid h-11 items-center gap-x-2 overflow-hidden rounded-xs border border-transparent cursor-pointer animate-row-in motion-reduce:animate-none",
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
			style={treeRowStyle()}
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
				{/* The time and the row actions share one slot: hover swaps them, and the title gives way. */}
				<span
					className={cn("min-w-11 text-right text-[10px] text-description", ROW_META_CLASS)}
					data-testid="inbox-row-time"
					title={activityTitle(row, now)}>
					{time}
				</span>
				<RowActions
					actions={threadRowActions(item.title || item.task, {
						stashed: !!item.isStashed,
						settled,
						onStash: () => void toggleTaskStashed(item.id),
						onSettle: () => void toggleTaskSettled(item.id),
					})}
				/>
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

/** A task row (shared with one view's list) and, expanded, its newest threads on the connector. */
const TaskGroupRowView = ({ row, now, expanded, onToggle, onOpen, animateLayout, settled = false }: TaskGroupRowViewProps) => {
	const { group, members } = row
	// Every member shows once expanded past the preview, so any thread can be settled from home.
	const [showAll, setShowAll] = useState(false)
	const shown = showAll ? members : members.slice(0, GROUP_PREVIEW_COUNT)
	const more = members.length - shown.length
	const open = () => onOpen?.(group.id)

	return (
		<TaskGroupBlock expanded={expanded} spine testId="inbox-task-group">
			<TaskGroupRow expanded={expanded} now={now} onOpen={open} onToggle={onToggle} row={row} settled={settled} />
			{expanded && (
				<TaskGroupMembers testId="inbox-task-group-members">
					{/* Active threads come first; settled ones follow, dimmed with a check, no divider needed. */}
					{shown.map((member) => (
						<InboxRowView
							animateLayout={animateLayout}
							key={member.item.id}
							now={now}
							row={member}
							// The task row above already shows the task's tags, so members list only their own.
							tags={(member.item.tags ?? []).map((tag) => ({ tag, inherited: false }))}
						/>
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
				</TaskGroupMembers>
			)}
		</TaskGroupBlock>
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
	const [stashedCollapsed, setStashedCollapsed] = useState(() => {
		try {
			return localStorage.getItem("inbox.stashedCollapsed") !== "0"
		} catch {
			return true
		}
	})
	const [stashedLimit, setStashedLimit] = useState(DEFAULT_SETTLED_LIMIT)
	const [settledCollapsed, setSettledCollapsed] = useState(readCollapsed)
	const [expandedGroups, setExpandedGroups] = useState(readExpandedTaskGroups)
	const { activeEntries, settled, settledTotal, stashed, stashedTotal, stashedNeedingYou, hiddenCount } = useMemo(
		() =>
			buildInbox(taskHistory ?? [], sessionStatuses, subagentCounts, {
				activeLimit,
				settledLimit,
				stashedLimit,
				taskGroups,
			}),
		[taskHistory, sessionStatuses, subagentCounts, activeLimit, settledLimit, stashedLimit, taskGroups],
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
	const toggleStashedCollapsed = () =>
		setStashedCollapsed((collapsed) => {
			try {
				localStorage.setItem("inbox.stashedCollapsed", collapsed ? "0" : "1")
			} catch {
				/* Best effort. */
			}
			return !collapsed
		})
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

	if (activeEntries.length === 0 && settledTotal === 0 && stashedTotal === 0) {
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
			{stashedTotal > 0 && (
				<>
					<button
						aria-expanded={!stashedCollapsed}
						aria-label={`${stashedCollapsed ? "Expand" : "Collapse"} stashed chats`}
						className={cn(
							sectionClass,
							"w-full cursor-pointer border-0 bg-transparent text-left hover:text-foreground",
						)}
						onClick={toggleStashedCollapsed}
						type="button">
						<span
							className={cn(
								"codicon codicon-chevron-down text-[12px] transition-transform duration-150 motion-reduce:transition-none",
								stashedCollapsed && "-rotate-90",
							)}
						/>
						<span>Stashed</span>
						<span className="opacity-70">{stashedTotal}</span>
						{stashedNeedingYou > 0 && (
							<span
								className="flex items-center gap-1 text-(--vscode-editorWarning-foreground)"
								data-testid="inbox-stashed-attention">
								<span className="h-1.5 w-1.5 rounded-full bg-current" />
								{stashedNeedingYou}
							</span>
						)}
					</button>
					<AnimatePresence initial={false}>
						{!stashedCollapsed && (
							<motion.div
								animate={reduceMotion ? undefined : { height: "auto", opacity: 1 }}
								exit={reduceMotion ? undefined : { height: 0, opacity: 0 }}
								initial={reduceMotion ? false : { height: 0, opacity: 0 }}
								key="stashed-rows"
								style={{ overflow: "hidden" }}
								transition={{ duration: 0.18, ease: "easeOut" }}>
								{stashed.map((entry) =>
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
								)}
								{(stashedTotal > stashed.length || stashedLimit > DEFAULT_SETTLED_LIMIT) && (
									<div className="flex gap-3 px-2 py-1">
										{stashedTotal > stashed.length && (
											<button
												className={moreClass}
												onClick={() => setStashedLimit((limit) => limit + SETTLED_PAGE_SIZE)}
												type="button">
												Show more ({stashedTotal - stashed.length})
											</button>
										)}
										{stashedLimit > DEFAULT_SETTLED_LIMIT && (
											<button
												className={moreClass}
												onClick={() => setStashedLimit(DEFAULT_SETTLED_LIMIT)}
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
