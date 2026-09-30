import { AnimatePresence, motion } from "framer-motion"
import { BotIcon, CheckIcon, MessageSquareIcon, RotateCcwIcon } from "lucide-react"
import { memo, useCallback, useMemo, useState } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useReducedMotionPreference } from "@/hooks/useReducedMotionPreference"
import { cn } from "@/lib/utils"
import {
	buildInbox,
	DEFAULT_SETTLED_LIMIT,
	describeActivity,
	formatAge,
	formatStamp,
	type InboxRow,
	SETTLED_PAGE_SIZE,
} from "./inboxUtils"
import { SessionStatusIcon } from "./SessionStatusIcon"
import { openTask, toggleTaskSettled } from "./sessionActions"

interface CountBadgeProps {
	icon: React.ReactNode
	count: number
	live: boolean
	title: string
}

export const CountBadge = ({ icon, count, live, title }: CountBadgeProps) => (
	<span
		className={cn(
			"inline-flex h-4 items-center gap-0.5 rounded-full border px-1.5 text-[10px] leading-none",
			live ? "border-link/60 text-link" : "border-editor-group-border text-description",
		)}
		title={title}>
		{icon}
		{count}
	</span>
)

interface InboxRowViewProps {
	row: InboxRow
	now: number
	animateLayout: boolean
}

const InboxRowView = ({ row, now, animateLayout }: InboxRowViewProps) => {
	const { item, status, settled, subthreadCount, liveSubthreadCount, subagentCount, liveSubagentCount } = row
	const time = settled ? formatStamp(item.settledAt ?? item.ts, now) : formatAge(item.ts, now)
	const activity = describeActivity(row, now)

	return (
		<motion.div
			className={cn(
				"group grid grid-cols-[14px_minmax(0,1fr)_auto] items-start gap-2 rounded-xs border border-transparent px-2 py-1.5 cursor-pointer animate-row-in",
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
			<div className="flex h-5 items-center justify-center">
				<SessionStatusIcon settled={settled} status={status} />
			</div>
			<div className="min-w-0">
				<div className="ph-no-capture truncate text-sm text-foreground">{item.task}</div>
				<div
					className={cn(
						"truncate text-xs",
						status === "running" && !settled
							? "animate-shimmer bg-linear-90 from-foreground to-description bg-[length:200%_100%] bg-clip-text text-transparent"
							: "text-description",
					)}>
					{activity}
				</div>
			</div>
			<div className="flex flex-col items-end gap-0.5">
				{(subagentCount > 0 || subthreadCount > 0) && (
					<div className="flex gap-1">
						{subagentCount > 0 && (
							<CountBadge
								count={liveSubagentCount || subagentCount}
								icon={<BotIcon className="size-2.5" />}
								live={liveSubagentCount > 0}
								title={`${subagentCount} subagent${subagentCount === 1 ? "" : "s"}${liveSubagentCount ? `, ${liveSubagentCount} running` : ""}`}
							/>
						)}
						{subthreadCount > 0 && (
							<CountBadge
								count={subthreadCount}
								icon={<MessageSquareIcon className="size-2.5" />}
								live={liveSubthreadCount > 0}
								title={`${subthreadCount} subthread${subthreadCount === 1 ? "" : "s"}${liveSubthreadCount ? `, ${liveSubthreadCount} running` : ""}`}
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
						aria-label={settled ? `Unsettle ${item.task}` : `Settle ${item.task}`}
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
	/** Clock override for tests. */
	now?: number
}

/**
 * Home inbox: active (unsettled) chats on top by recency, settled chats below.
 * Status comes from the host's live `sessionStatuses`; asides are folded into
 * their parent's subthread count.
 */
const InboxList = ({ showHistoryView, now = Date.now() }: InboxListProps) => {
	const { taskHistory, sessionStatuses, subagentCounts } = useExtensionState()
	const reduceMotion = useReducedMotionPreference()
	const [settledLimit, setSettledLimit] = useState(DEFAULT_SETTLED_LIMIT)
	const [settledCollapsed, setSettledCollapsed] = useState(readCollapsed)
	const { active, settled, settledTotal, hiddenCount } = useMemo(
		() => buildInbox(taskHistory ?? [], sessionStatuses, subagentCounts, { settledLimit }),
		[taskHistory, sessionStatuses, subagentCounts, settledLimit],
	)
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

	if (active.length === 0 && settledTotal === 0) {
		return null
	}

	const sectionClass =
		"flex items-center gap-1.5 px-2 pt-2.5 pb-1 text-[10.5px] font-medium uppercase tracking-wider text-description"

	const moreClass = "border-0 bg-transparent p-0 text-xs text-description hover:text-foreground cursor-pointer"

	return (
		<div className="shrink-0 px-3" data-testid="inbox-list">
			<div className={sectionClass}>
				<span>Active</span>
				<span className="opacity-70">{active.length}</span>
				<button
					aria-label="View all history"
					className="ml-auto flex items-center gap-0.5 border-0 bg-transparent p-0 text-[10.5px] normal-case tracking-normal text-description hover:text-foreground cursor-pointer"
					onClick={showHistoryView}
					type="button">
					View all history
					<span className="codicon codicon-chevron-right text-[12px]" />
				</button>
			</div>
			{active.length > 0 ? (
				active.map((row) => <InboxRowView animateLayout={!reduceMotion} key={row.item.id} now={now} row={row} />)
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
								{settled.map((row) => (
									<InboxRowView animateLayout={!reduceMotion} key={row.item.id} now={now} row={row} />
								))}
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
					onClick={showHistoryView}
					type="button">
					{hiddenCount} more in history
				</button>
			)}
		</div>
	)
}

export default memo(InboxList)
