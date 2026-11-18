import type { ClineMessage } from "@shared/ExtensionMessage"
import type { HistoryItem } from "@shared/HistoryItem"
import type { WorktreeSummary } from "@shared/thread-worktrees"
import { MessageSquareDashedIcon, SplitIcon } from "lucide-react"
import { type ReactNode, useEffect, useMemo, useState } from "react"
import { closeSideThread, openSideThread, reopenSideThread } from "@/components/chat/chat-view/utils/asideUtils"
import { buildThreadPath, type LineageRow } from "@/components/chat/chat-view/utils/threadUtils"
import { useBranchTaskSuggestion } from "@/components/chat/composer/BranchTaskSuggestion"
import { AUTO_COMPACT_PERCENT, useComposerContextUsage } from "@/components/chat/composer/ContextUsageIndicator"
import { contextUsagePercent, formatChatCost } from "@/components/chat/composer/contextUsage"
import { TASK_MENU_CLASS, TaskPickerMenu } from "@/components/chat/composer/WherePill"
import { SubagentDecisionControls } from "@/components/chat/SubagentDecisionControls"
import { useSubagentLineage } from "@/components/chat/task-header/SubagentPanel"
import { MENU_ICON_CLASS, MENU_ITEM_CLASS, MENU_SEPARATOR_CLASS } from "@/components/common/menuStyles"
import { STATUS_LABEL } from "@/components/inbox/SessionStatusIcon"
import { openTask, stopSubagent } from "@/components/inbox/sessionActions"
import { formatListTime } from "@/components/oneView/listTime"
import { useTaskGroup } from "@/components/taskGroup/useTaskGroup"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { worktreeStatusText } from "@/components/worktrees/ThreadWorktreeActions"
import { threadWorktreeAction, useWorktree } from "@/components/worktrees/useWorktree"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { cn } from "@/lib/utils"
import { type AgentRow, buildAgentRows, changedFiles, isLiveAgent, shortTokens, splitAgentRows } from "./threadPanelModel"
import { PANEL_SECTION_LABEL, PANEL_SECTIONS, type PanelSection, useThreadPanelPrefs } from "./threadPanelPrefs"

const ROW_CLASS = "flex min-h-6 min-w-0 items-center gap-1.75 py-px pr-2 pl-3 text-[12px]"
const ACTION_ROW_CLASS = cn(
	ROW_CLASS,
	"w-full cursor-pointer border-0 bg-transparent text-left text-description hover:bg-list-hover hover:text-foreground focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-(--vscode-focusBorder)",
)
const META_CLASS = "shrink-0 whitespace-nowrap text-[11px] text-description"
const SUB_CLASS = "flex flex-wrap items-center gap-1.25 pr-2 pb-1 pl-8.25 text-[11px] text-description"
const MINI_BUTTON_CLASS =
	"inline-flex h-4.5 shrink-0 cursor-pointer items-center gap-0.75 whitespace-nowrap rounded-xs border border-editor-group-border bg-button-secondary-background px-1.5 text-[11px] text-button-secondary-foreground hover:bg-button-secondary-background-hover"
const ROW_ICON_BUTTON_CLASS =
	"flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-xs border-0 bg-transparent p-0 text-description hover:bg-toolbar-hover hover:text-foreground focus-visible:outline focus-visible:outline-1 focus-visible:outline-(--vscode-focusBorder)"

const DOT_CLASS: Record<string, string> = {
	running: "bg-link animate-breathe motion-reduce:animate-none",
	waiting: "bg-warning",
	subagents: "bg-(--vscode-charts-purple)",
	done: "bg-success",
	error: "bg-error",
	stopped: "bg-description",
}

export const StatusDot = ({ status, label }: { status: string; label?: string }) => (
	<span
		aria-label={label ?? STATUS_LABEL[status as keyof typeof STATUS_LABEL] ?? status}
		className={cn("inline-block size-1.75 shrink-0 rounded-full", DOT_CLASS[status] ?? "bg-description")}
		role="img"
	/>
)

/** A section: an uppercase header that folds (remembered), then its rows. */
const Section = ({
	section,
	count,
	right,
	children,
}: {
	section: PanelSection
	count?: ReactNode
	right?: ReactNode
	children: ReactNode
}) => {
	const { folded, toggleFolded } = useThreadPanelPrefs()
	const open = !folded.includes(section)
	return (
		<section
			className="border-0 border-b border-solid border-border-panel py-1.25 last:border-b-0"
			data-section={section}
			data-testid="thread-panel-section">
			<button
				aria-expanded={open}
				className="flex h-6 w-full min-w-0 cursor-pointer items-center gap-1.5 border-0 bg-transparent pr-2.5 pl-2 text-left select-none hover:bg-list-hover focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-(--vscode-focusBorder)"
				onClick={() => toggleFolded(section)}
				type="button">
				<span
					aria-hidden
					className={cn(
						"codicon codicon-chevron-down text-[12px] text-description transition-transform duration-150 motion-reduce:transition-none",
						!open && "-rotate-90",
					)}
				/>
				<span className="whitespace-nowrap text-[10.5px] font-semibold uppercase tracking-wider text-description">
					{PANEL_SECTION_LABEL[section]}
				</span>
				{count !== undefined && <span className="min-w-0 truncate text-[10.5px] text-description/75">{count}</span>}
				<span className="flex-1" />
				{right}
			</button>
			{open && <div>{children}</div>}
		</section>
	)
}

// ---- Branch & changes ----

const WhereSection = ({ item, messages }: { item: HistoryItem; messages: readonly ClineMessage[] }) => {
	const { currentBranch, navigateToWalkthrough, sessionStatuses } = useExtensionState()
	const worktree = useWorktree(item.id)
	const mapping = worktree.state?.mapping
	const [summary, setSummary] = useState<WorktreeSummary>()
	const status = sessionStatuses?.[item.id]
	const files = useMemo(() => changedFiles(messages), [messages])
	useEffect(() => {
		if (!mapping) return
		let cancelled = false
		threadWorktreeAction("summary", item.id)
			.then((result) => {
				if (!cancelled) setSummary(result.summary)
			})
			.catch(() => undefined)
		return () => {
			cancelled = true
		}
		// Refreshed when the thread's run status moves (a turn ends, edits land).
	}, [mapping, item.id, status, files.length])

	return (
		<Section section="where">
			{mapping ? (
				<>
					<div className={ROW_CLASS} title={`This thread runs in its own worktree on ${mapping.branch}`}>
						<span
							aria-hidden
							className="codicon codicon-git-branch shrink-0 text-[13px] text-(--vscode-charts-green)"
						/>
						<span className="min-w-0 flex-1 truncate font-mono">{mapping.branch}</span>
						<span className={META_CLASS}>worktree</span>
					</div>
					{summary && <div className={SUB_CLASS}>{worktreeStatusText(summary)}</div>}
				</>
			) : (
				<div className={ROW_CLASS}>
					<span aria-hidden className="codicon codicon-git-branch shrink-0 text-[13px] text-description" />
					<span className="min-w-0 flex-1 truncate font-mono">{currentBranch || "Your workspace"}</span>
					<span className={META_CLASS}>workspace</span>
				</div>
			)}
			<div className={ROW_CLASS} title={files.join("\n") || undefined}>
				<span aria-hidden className="codicon codicon-diff shrink-0 text-[13px] text-description" />
				<span className="min-w-0 flex-1 truncate">
					{files.length ? (
						<>
							Changes{" "}
							<span className="text-description">· {files.length === 1 ? "1 file" : `${files.length} files`}</span>
						</>
					) : (
						<span className="text-description">No file changes yet</span>
					)}
				</span>
			</div>
			<div className={ROW_CLASS}>
				<span aria-hidden className="codicon codicon-list-ordered shrink-0 text-[13px] text-description" />
				<span className="min-w-0 flex-1 truncate">Walkthrough</span>
				<button className={MINI_BUTTON_CLASS} onClick={() => navigateToWalkthrough()} type="button">
					Open
				</button>
			</div>
		</Section>
	)
}

// ---- Agents ----

const KIND_LABEL: Record<AgentRow["kind"], string> = { side: "Side thread", btw: "Side question", subagent: "Subagent" }

const KindIcon = ({ kind }: { kind: AgentRow["kind"] }) =>
	kind === "subagent" ? (
		<span aria-hidden className="codicon codicon-hubot shrink-0 text-[12px] text-description" />
	) : kind === "btw" ? (
		<MessageSquareDashedIcon aria-hidden className="size-3 shrink-0 text-description" />
	) : (
		<SplitIcon aria-hidden className="size-3 shrink-0 text-description" />
	)

function agentMeta(row: AgentRow, now: number): string {
	const status =
		row.tucked && row.kind !== "subagent"
			? row.kind === "btw"
				? "side question"
				: "closed"
			: row.status === "waiting"
				? "needs you"
				: row.status === "subagents"
					? "waiting on subagents"
					: row.status === "running"
						? "running"
						: row.status === "error"
							? "error"
							: row.status === "stopped"
								? "stopped"
								: "done"
	return row.ts && !isLiveAgent(row) ? `${status} · ${formatListTime(row.ts, now)}` : status
}

const AgentRowView = ({
	row,
	mainId,
	onOpenPreview,
	decision,
}: {
	row: AgentRow
	mainId: string
	onOpenPreview?: (row: LineageRow) => void
	decision?: ClineMessage
}) => {
	const [busy, setBusy] = useState(false)
	const live = isLiveAgent(row)
	const now = Date.now()
	const open = () => {
		if (row.kind === "subagent") {
			if (row.previewOnly) onOpenPreview?.({ id: row.id, title: row.title, status: row.status, previewOnly: true })
			else void openTask(row.id)
			return
		}
		if (row.tucked) void reopenSideThread(row.id).catch(() => undefined)
		openSideThread(mainId, row.id)
	}
	const canOpen = row.kind !== "subagent" || !row.previewOnly || !!onOpenPreview
	return (
		<>
			<div
				className="group/agent flex min-w-0 items-center hover:bg-list-hover"
				data-kind={row.kind}
				data-testid="agent-row">
				<button
					aria-label={`Open ${KIND_LABEL[row.kind].toLowerCase()} ${row.title}`}
					className={cn(
						ROW_CLASS,
						"min-w-0 flex-1 border-0 bg-transparent text-left text-foreground focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-(--vscode-focusBorder)",
						canOpen ? "cursor-pointer" : "cursor-default",
						row.tucked && "text-description",
					)}
					disabled={!canOpen}
					onClick={open}
					title={`${KIND_LABEL[row.kind]}: ${row.title}`}
					type="button">
					<StatusDot status={row.status} />
					<KindIcon kind={row.kind} />
					<span className="min-w-0 flex-1 truncate">{row.title}</span>
					{row.access && (
						<span
							aria-label={row.access === "write" ? "Can edit" : "Read-only"}
							className={cn(
								"codicon shrink-0 text-[12px]",
								row.access === "write" ? "codicon-edit text-warning" : "codicon-eye text-description",
							)}
							role="img"
						/>
					)}
					<span
						className={cn(
							META_CLASS,
							row.status === "waiting" && !row.tucked && "text-warning",
							(live || (row.kind !== "subagent" && !row.tucked)) &&
								"group-hover/agent:hidden group-focus-within/agent:hidden",
						)}>
						{agentMeta(row, now)}
					</span>
				</button>
				{live && row.kind === "subagent" && (
					<button
						aria-label={`Stop ${row.title}`}
						className={cn(ROW_ICON_BUTTON_CLASS, "mr-1 hidden group-hover/agent:flex group-focus-within/agent:flex")}
						disabled={busy}
						onClick={() => {
							setBusy(true)
							void stopSubagent(row.parentTaskId ?? mainId, row.id).finally(() => setBusy(false))
						}}
						title="Stop"
						type="button">
						<span aria-hidden className="codicon codicon-debug-stop text-[13px]" />
					</button>
				)}
				{row.kind !== "subagent" && !row.tucked && (
					<button
						aria-label={`Close ${row.title}`}
						className={cn(ROW_ICON_BUTTON_CLASS, "mr-1 hidden group-hover/agent:flex group-focus-within/agent:flex")}
						onClick={() => void closeSideThread(row.id).catch((error) => console.error("Failed to close:", error))}
						title={live ? "Stop and close · stays under Main" : "Close · stays under Main"}
						type="button">
						<span aria-hidden className="codicon codicon-close text-[13px]" />
					</button>
				)}
			</div>
			{decision && (
				<div className={SUB_CLASS}>
					<SubagentDecisionControls compact key={decision.decisionId} message={decision} />
				</div>
			)}
		</>
	)
}

const AgentsSection = ({
	item,
	onNewSideThread,
	onOpenSubagentPreview,
}: {
	item: HistoryItem
	onNewSideThread?: () => void
	onOpenSubagentPreview?: (row: LineageRow) => void
}) => {
	const { taskHistory, sessionStatuses, pendingSubagentDecisions } = useExtensionState()
	const lineage = useSubagentLineage()
	const [showMore, setShowMore] = useState(false)
	const rows = useMemo(
		() => buildAgentRows(item.id, taskHistory ?? [], sessionStatuses, lineage?.children ?? []),
		[item.id, taskHistory, sessionStatuses, lineage?.children],
	)
	const { shown, more } = splitAgentRows(rows)
	const attention = rows.filter((row) => row.status === "waiting" && !row.tucked).length
	const listed = showMore ? [...shown, ...more] : shown
	return (
		<Section
			count={rows.length || undefined}
			right={attention ? <span className="text-[11px] text-warning">{attention} needs you</span> : undefined}
			section="agents">
			{listed.map((row) => (
				<AgentRowView
					decision={pendingSubagentDecisions?.find((pending) => pending.taskId === row.id)?.message}
					key={row.id}
					mainId={item.id}
					onOpenPreview={onOpenSubagentPreview}
					row={row}
				/>
			))}
			{rows.length === 0 && <div className={cn(SUB_CLASS, "pl-3")}>No side threads or subagents from this thread yet.</div>}
			{more.length > 0 && (
				<button className={ACTION_ROW_CLASS} onClick={() => setShowMore((value) => !value)} type="button">
					<span
						aria-hidden
						className={cn("codicon text-[12px]", showMore ? "codicon-chevron-up" : "codicon-chevron-down")}
					/>
					<span className="min-w-0 flex-1 truncate">{showMore ? "Show less" : `Show ${more.length} more`}</span>
				</button>
			)}
			{onNewSideThread && !item.isSubagent && (
				<button className={ACTION_ROW_CLASS} onClick={onNewSideThread} type="button">
					<SplitIcon aria-hidden className="size-3 shrink-0" />
					<span className="min-w-0 flex-1 truncate">New side thread</span>
					<kbd className="text-[10px]">/side</kbd>
				</button>
			)}
		</Section>
	)
}

// ---- Notes ----

const TaskNotes = ({ taskGroupId, threadId }: { taskGroupId: string; threadId: string }) => {
	const { navigateToTaskGroup } = useExtensionState()
	const { details, missing } = useTaskGroup(taskGroupId)
	const row = details?.threads.find((thread) => thread.threadId === threadId)
	const name = (slug: string) => details?.notes.find((note) => note.slug === slug)?.name ?? slug
	const wrote = row?.wrote ?? []
	const read = (row?.read ?? []).filter((slug) => !wrote.includes(slug))
	const openNotebook = () => navigateToTaskGroup(taskGroupId, "notebook")
	return (
		<Section count={details ? `· ${details.group.title}` : undefined} section="notes">
			{missing ? (
				<div className={cn(SUB_CLASS, "pl-3")}>This thread's task is gone, so it has no notebook.</div>
			) : (
				<>
					{wrote.map((slug) => (
						<button
							className={cn(ACTION_ROW_CLASS, "text-foreground")}
							key={`w:${slug}`}
							onClick={openNotebook}
							type="button">
							<span
								aria-hidden
								className="codicon codicon-edit shrink-0 text-[12px] text-(--vscode-charts-purple)"
							/>
							<span className="min-w-0 flex-1 truncate">{name(slug)}</span>
							<span className={META_CLASS}>wrote</span>
						</button>
					))}
					{read.map((slug) => (
						<button
							className={cn(ACTION_ROW_CLASS, "text-foreground")}
							key={`r:${slug}`}
							onClick={openNotebook}
							type="button">
							<span aria-hidden className="codicon codicon-eye shrink-0 text-[12px] text-description" />
							<span className="min-w-0 flex-1 truncate">{name(slug)}</span>
							<span className={META_CLASS}>read</span>
						</button>
					))}
					{details && !wrote.length && !read.length && (
						<div className={cn(SUB_CLASS, "pl-3")}>This thread hasn't read or written a note yet.</div>
					)}
					<button className={ACTION_ROW_CLASS} onClick={openNotebook} type="button">
						<span aria-hidden className="codicon codicon-book shrink-0 text-[12px]" />
						<span className="min-w-0 flex-1 truncate">Open the task's notebook</span>
						<span aria-hidden className="codicon codicon-chevron-right text-[12px]" />
					</button>
				</>
			)}
		</Section>
	)
}

const NotesSection = ({ item }: { item: HistoryItem }) => {
	const { taskHistory } = useExtensionState()
	const suggestion = useBranchTaskSuggestion()
	const [open, setOpen] = useState(false)
	const taskGroupId = buildThreadPath(item, taskHistory ?? []).taskGroupId
	if (taskGroupId) return <TaskNotes taskGroupId={taskGroupId} threadId={item.id} />
	return (
		<Section section="notes">
			<div className={cn(SUB_CLASS, "pl-3")}>Notes belong to a task, and this thread isn't in one.</div>
			{!item.isSubagent && (
				<Popover onOpenChange={setOpen} open={open}>
					<PopoverTrigger asChild>
						<button className={ACTION_ROW_CLASS} type="button">
							<span aria-hidden className="codicon codicon-tasklist shrink-0 text-[12px]" />
							<span className="min-w-0 flex-1 truncate">File into a task…</span>
						</button>
					</PopoverTrigger>
					<PopoverContent align="start" className={cn(TASK_MENU_CLASS, "motion-reduce:animate-none")} side="bottom">
						<TaskPickerMenu onClose={() => setOpen(false)} suggestion={suggestion} />
					</PopoverContent>
				</Popover>
			)}
		</Section>
	)
}

// ---- Context & cost ----

export interface ThreadUsage {
	totalCost?: number
	lastApiReqTotalTokens?: number
}

const ContextSection = ({ usage }: { usage: ThreadUsage }) => {
	const { mode, useAutoCondense } = useExtensionState()
	const lineage = useSubagentLineage()
	const { contextWindow } = useComposerContextUsage(mode, usage.totalCost)
	const percent = contextUsagePercent(usage.lastApiReqTotalTokens, contextWindow)
	const subagentCost = (lineage?.children ?? []).reduce((sum, row) => sum + (row.cost ?? 0), 0)
	const autoCompact = useAutoCondense !== false
	const cost = formatChatCost(usage.totalCost)
	return (
		<Section count={percent !== undefined ? `${Math.round(percent)}%` : undefined} section="context">
			<div className="flex min-w-0 items-center gap-2 py-1 pr-2.5 pl-3 text-[11px]">
				{percent !== undefined && contextWindow ? (
					<>
						<div
							aria-label={`Context ${Math.round(percent)}% used`}
							className="relative h-1 min-w-10 flex-1 rounded-full bg-input-border"
							role="img"
							title={autoCompact ? `Auto-compact at ${AUTO_COMPACT_PERCENT}%` : "Auto-compact is off"}>
							<i
								className="absolute inset-y-0 left-0 rounded-full bg-foreground/70"
								style={{ width: `${Math.max(2, percent)}%` }}
							/>
							{autoCompact && (
								<b
									className="absolute -top-0.75 -bottom-0.75 w-0.5 rounded-xs bg-description"
									style={{ left: `${AUTO_COMPACT_PERCENT}%` }}
								/>
							)}
						</div>
						<span className="shrink-0 font-mono text-description">
							{shortTokens(usage.lastApiReqTotalTokens ?? 0)} / {shortTokens(contextWindow)}
						</span>
					</>
				) : (
					<span className="text-description">Context use shows after the first reply.</span>
				)}
			</div>
			<div className={ROW_CLASS}>
				<span className="min-w-0 flex-1 truncate">
					Cost
					{subagentCost > 0 && <span className="text-description"> · subagents {formatChatCost(subagentCost)}</span>}
				</span>
				<span className="shrink-0 font-mono">{cost ?? "$0.00"}</span>
			</div>
		</Section>
	)
}

// ---- Panel ----

interface ThreadPanelProps {
	item: HistoryItem
	messages: readonly ClineMessage[]
	usage: ThreadUsage
	onNewSideThread?: () => void
	onOpenSubagentPreview?: (row: LineageRow) => void
}

/** The sections of "This thread", in order, minus the ones the user turned off. One scroll region: its parent. */
export const ThreadPanelSections = ({ item, messages, usage, onNewSideThread, onOpenSubagentPreview }: ThreadPanelProps) => {
	const { hidden, showAll } = useThreadPanelPrefs()
	const visible = PANEL_SECTIONS.filter((section) => !hidden.includes(section))
	if (visible.length === 0)
		return (
			<div className="flex flex-col items-start gap-1.5 px-3 py-3 text-[12px] text-description">
				<span>Every section is turned off.</span>
				<button className={MINI_BUTTON_CLASS} onClick={showAll} type="button">
					Show all sections
				</button>
			</div>
		)
	return (
		<div data-testid="thread-panel-sections">
			{visible.map((section) =>
				section === "where" ? (
					<WhereSection item={item} key={section} messages={messages} />
				) : section === "agents" ? (
					<AgentsSection
						item={item}
						key={section}
						onNewSideThread={onNewSideThread}
						onOpenSubagentPreview={onOpenSubagentPreview}
					/>
				) : section === "notes" ? (
					<NotesSection item={item} key={section} />
				) : (
					<ContextSection key={section} usage={usage} />
				),
			)}
		</div>
	)
}

/** "Sections" menu in the panel header: which sections show (remembered). */
export const PanelSectionsMenu = () => {
	const { hidden, toggleShown } = useThreadPanelPrefs()
	const [open, setOpen] = useState(false)
	return (
		<Popover onOpenChange={setOpen} open={open}>
			<PopoverTrigger asChild>
				<button
					aria-label="Choose sections"
					className={cn(ROW_ICON_BUTTON_CLASS, open && "bg-toolbar-hover text-foreground")}
					data-testid="thread-panel-sections-menu"
					title="Choose what this panel shows"
					type="button">
					<span aria-hidden className="codicon codicon-settings text-[13px]" />
				</button>
			</PopoverTrigger>
			<PopoverContent align="end" className="w-48 p-1 motion-reduce:animate-none" side="bottom">
				<div className="flex flex-col" role="menu">
					<div className="px-2 pt-1 pb-0.5 text-[10px] font-medium uppercase tracking-wider text-description">Show</div>
					{PANEL_SECTIONS.map((section) => (
						<button
							aria-checked={!hidden.includes(section)}
							className={MENU_ITEM_CLASS}
							key={section}
							onClick={() => toggleShown(section)}
							role="menuitemcheckbox"
							type="button">
							<span
								aria-hidden
								className={cn(MENU_ICON_CLASS, hidden.includes(section) ? "codicon-blank" : "codicon-check")}
							/>
							<span className="flex-1">{PANEL_SECTION_LABEL[section]}</span>
						</button>
					))}
					<hr className={MENU_SEPARATOR_CLASS} />
					<div className="px-2 pb-1 text-[10.5px] text-description">Folded sections stay folded, too.</div>
				</div>
			</PopoverContent>
		</Popover>
	)
}

export { MINI_BUTTON_CLASS, ROW_ICON_BUTTON_CLASS }
