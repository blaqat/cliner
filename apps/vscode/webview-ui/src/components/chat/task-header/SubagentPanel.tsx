import type { ClineMessage } from "@shared/ExtensionMessage"
import { useEffect, useMemo, useRef, useState } from "react"
import {
	buildSubagentLineage,
	isStoppable,
	type LineageRow,
	needsAttention,
	type SubagentLineage,
} from "@/components/chat/chat-view/utils/threadUtils"
import type { SessionStatus } from "@/components/inbox/inboxUtils"
import { openTask, stopSubagent } from "@/components/inbox/sessionActions"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { cn } from "@/lib/utils"
import { SubagentDecisionControls } from "../SubagentDecisionControls"
import { HeaderIconButton } from "./HeaderIconButton"

const STATUS_LABEL: Record<SessionStatus, string> = {
	running: "running",
	waiting: "needs you",
	done: "done",
	error: "error",
}

const DOT_CLASS: Record<SessionStatus, string> = {
	running: "bg-link animate-breathe motion-reduce:animate-none",
	waiting: "bg-warning",
	done: "bg-success",
	error: "bg-error",
}

/** The focused thread's subagent lineage, recomputed from extension state. */
export function useSubagentLineage(): SubagentLineage | undefined {
	const { currentTaskItem, taskHistory, sessionStatuses, clineMessages, subagentView } = useExtensionState()
	return useMemo(
		() =>
			buildSubagentLineage(currentTaskItem, taskHistory ?? [], sessionStatuses, clineMessages, subagentView?.parentTaskId),
		[currentTaskItem, taskHistory, sessionStatuses, clineMessages, subagentView?.parentTaskId],
	)
}

const AccessIcon = ({ access }: { access: "read" | "write" }) => {
	const label = access === "write" ? "Can edit" : "Read-only"
	return (
		<Tooltip>
			<TooltipContent className="px-2 py-1" side="left">
				{label}
			</TooltipContent>
			<TooltipTrigger asChild>
				<span
					aria-label={label}
					className={cn(
						"codicon shrink-0 text-[13px]",
						access === "write" ? "codicon-edit text-warning" : "codicon-eye text-description",
					)}
					data-testid="lineage-access"
					role="img"
				/>
			</TooltipTrigger>
		</Tooltip>
	)
}

interface LineageRowViewProps {
	row: LineageRow
	relation: "parent" | "current" | "child"
	stopping: boolean
	/** The last Stop for this row failed; Stop stays enabled to retry. */
	stopFailed?: boolean
	onOpen?: () => void
	onStop?: () => void
	decisionMessage?: ClineMessage
}

const LineageRowView = ({ row, relation, stopping, stopFailed, onOpen, onStop, decisionMessage }: LineageRowViewProps) => {
	const label = stopping ? "stopping…" : stopFailed ? "couldn't stop" : STATUS_LABEL[row.status]
	return (
		<div
			className={cn(
				"group/row flex items-center gap-1 pr-1 animate-row-in motion-reduce:animate-none",
				relation === "current" && "bg-selection/50",
				relation === "child" && "pl-3",
			)}
			data-relation={relation}
			data-testid="lineage-row">
			<button
				aria-current={relation === "current" || undefined}
				aria-label={relation === "parent" ? `Open parent ${row.title}` : `Open ${row.title}`}
				className={cn(
					"flex h-6.5 min-w-0 flex-1 items-center gap-1.5 border-0 bg-transparent px-2 text-left text-[12px] text-foreground",
					"focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-(--vscode-focusBorder)",
					onOpen ? "cursor-pointer hover:bg-list-hover" : "cursor-default",
					relation === "parent" && "text-description",
				)}
				data-lineage-row
				disabled={!onOpen}
				onClick={onOpen}
				type="button">
				{relation === "parent" && <span aria-hidden className="codicon codicon-arrow-up shrink-0 text-[12px]" />}
				<span
					aria-label={STATUS_LABEL[row.status]}
					className={cn("inline-block size-1.75 shrink-0 rounded-full", DOT_CLASS[row.status])}
					role="img"
				/>
				{row.access && <AccessIcon access={row.access} />}
				<span className="min-w-0 flex-1 truncate">{row.title}</span>
				<span
					className={cn(
						"shrink-0 text-[10.5px]",
						stopFailed
							? "text-error"
							: needsAttention(row) && relation === "child"
								? "text-warning"
								: "text-description",
					)}
					data-testid="lineage-status">
					{relation === "parent" ? "parent" : label}
				</span>
			</button>
			{decisionMessage && <SubagentDecisionControls compact key={decisionMessage.decisionId} message={decisionMessage} />}
			{onStop && (
				<Tooltip>
					<TooltipContent className="px-2 py-1" side="left">
						{stopFailed ? "Stop failed. Try again" : "Stop subagent"}
					</TooltipContent>
					<TooltipTrigger asChild>
						<button
							aria-label={`Stop ${row.title}`}
							className="flex size-5 shrink-0 items-center justify-center rounded-xs border-0 bg-transparent p-0 text-description cursor-pointer hover:bg-toolbar-hover hover:text-error disabled:opacity-50"
							disabled={stopping}
							onClick={onStop}
							type="button">
							<span aria-hidden className="codicon codicon-debug-stop text-[13px]" />
						</button>
					</TooltipTrigger>
				</Tooltip>
			)}
		</div>
	)
}

interface SubagentPanelButtonProps {
	/** Opens a transcript-only subagent (no saved thread) by scrolling to its status row. */
	onOpenPreview?: (row: LineageRow) => void
}

/**
 * Header button for the focused thread's subagents: a count of its direct
 * children (yellow when one needs the user) that opens a popover with the
 * immediate parent, the current thread, and those children. Hidden when the
 * lineage has no subagents at all.
 */
export const SubagentPanelButton = ({ onOpenPreview }: SubagentPanelButtonProps) => {
	const lineage = useSubagentLineage()
	const { pendingSubagentDecisions } = useExtensionState()
	const [open, setOpen] = useState(false)
	// Rows with a Stop request in flight or sent but not yet reflected in their
	// status, and rows whose last Stop failed (retryable).
	const [stoppingIds, setStoppingIds] = useState<ReadonlySet<string>>(() => new Set())
	const [failedIds, setFailedIds] = useState<ReadonlySet<string>>(() => new Set())
	const inFlight = useRef(new Set<string>())
	const listRef = useRef<HTMLDivElement>(null)

	// A child that left "running" (stopped, done, errored) needs no pending or
	// failed Stop state anymore.
	const liveKey = (lineage?.children ?? [])
		.filter(isStoppable)
		.map((row) => row.id)
		.join("\n")
	useEffect(() => {
		const live = new Set(liveKey ? liveKey.split("\n") : [])
		const prune = (ids: ReadonlySet<string>) => {
			const kept = [...ids].filter((id) => live.has(id) || inFlight.current.has(id))
			return kept.length === ids.size ? ids : new Set(kept)
		}
		setStoppingIds(prune)
		setFailedIds(prune)
	}, [liveKey])

	const handleOpenChange = (next: boolean) => {
		if (next) {
			// Drop errors and anything not actually awaiting a response.
			setFailedIds(new Set())
			setStoppingIds((ids) => new Set([...ids].filter((id) => inFlight.current.has(id))))
		}
		setOpen(next)
	}

	if (!lineage || (!lineage.parent && lineage.children.length === 0)) {
		return null
	}
	const { parent, current, children } = lineage
	const attention = children.some(needsAttention)
	const live = children.filter(isStoppable)

	const failedCount = live.filter((row) => failedIds.has(row.id)).length

	const stop = (rows: LineageRow[]) => {
		const targets = rows.filter((row) => !inFlight.current.has(row.id))
		if (targets.length === 0) return
		const ids = targets.map((row) => row.id)
		for (const id of ids) inFlight.current.add(id)
		setStoppingIds((prev) => new Set([...prev, ...ids]))
		setFailedIds((prev) => new Set([...prev].filter((id) => !ids.includes(id))))
		for (const row of targets) {
			void stopSubagent(row.parentTaskId ?? current.id, row.id).then((ok) => {
				inFlight.current.delete(row.id)
				if (ok) return // Cleared once the child's status leaves running.
				setStoppingIds((prev) => new Set([...prev].filter((id) => id !== row.id)))
				setFailedIds((prev) => new Set([...prev, row.id]))
			})
		}
	}
	const openRow = (row: LineageRow) => {
		if (row.previewOnly) {
			onOpenPreview?.(row)
		} else {
			void openTask(row.id)
		}
		setOpen(false)
	}
	const canOpen = (row: LineageRow) => (row.previewOnly ? !!onOpenPreview : true)

	// Arrow keys move between rows; Tab still reaches each row's Stop button.
	const handleKeyDown = (event: React.KeyboardEvent) => {
		const rows = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>("[data-lineage-row]:not(:disabled)") ?? [])
		if (rows.length === 0) return
		const index = rows.indexOf(document.activeElement as HTMLButtonElement)
		const next =
			event.key === "ArrowDown"
				? rows[(index + 1) % rows.length]
				: event.key === "ArrowUp"
					? rows[(index - 1 + rows.length) % rows.length]
					: event.key === "Home"
						? rows[0]
						: event.key === "End"
							? rows[rows.length - 1]
							: undefined
		if (next) {
			event.preventDefault()
			next.focus()
		}
	}

	const count = children.length
	const tooltip = attention
		? "Subagents: one needs you"
		: `${count} subagent${count === 1 ? "" : "s"}${live.length ? `, ${live.length} running` : ""}`

	return (
		<Popover onOpenChange={handleOpenChange} open={open}>
			<PopoverTrigger asChild>
				<HeaderIconButton
					data-attention={attention || undefined}
					data-testid="subagents-button"
					icon="type-hierarchy-sub"
					label={`Subagents (${count})`}
					tooltip={tooltip}>
					{count > 0 && (
						<span
							className={cn(
								"absolute -top-1 -right-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full px-0.75 text-[9px] leading-none font-semibold transition-colors duration-200 motion-reduce:transition-none",
								attention
									? "bg-warning text-(--vscode-editor-background)"
									: "bg-badge-background text-badge-foreground",
							)}
							data-testid="subagents-badge">
							{count}
						</span>
					)}
				</HeaderIconButton>
			</PopoverTrigger>
			<PopoverContent
				align="end"
				aria-label="Subagents"
				className="w-80 max-w-[calc(100vw-1.5rem)] p-0 motion-reduce:animate-none"
				data-testid="subagent-panel"
				onOpenAutoFocus={(event) => {
					// Land on the first row so arrow keys work immediately.
					event.preventDefault()
					listRef.current?.querySelector<HTMLButtonElement>("[data-lineage-row]:not(:disabled)")?.focus()
				}}
				side="bottom">
				<div className="flex items-center gap-2 border-b border-menu-foreground/10 px-2.5 py-1.5">
					<span className="flex-1 text-[12px] font-semibold">Subagents</span>
					{live.length > 0 && (
						<button
							className="flex h-5 items-center gap-1 rounded-xs border border-editor-group-border bg-button-secondary-background px-1.5 text-[11px] text-button-secondary-foreground cursor-pointer hover:bg-button-secondary-background-hover disabled:opacity-50"
							disabled={live.every((row) => stoppingIds.has(row.id))}
							onClick={() => stop(live)}
							type="button">
							<span aria-hidden className="codicon codicon-debug-stop text-[12px]" />
							Stop all
						</button>
					)}
					<kbd className="text-[10px] text-description">Esc</kbd>
				</div>
				{failedCount > 0 && (
					<div
						className="flex items-center gap-1.5 border-b border-menu-foreground/10 px-2.5 py-1 text-[11px] text-error"
						data-testid="subagent-stop-error"
						role="alert">
						<span aria-hidden className="codicon codicon-error text-[12px]" />
						<span className="flex-1">
							Couldn't stop {failedCount} subagent{failedCount === 1 ? "" : "s"}.
						</span>
						<button
							className="border-0 bg-transparent p-0 text-[11px] text-link cursor-pointer hover:underline"
							onClick={() => stop(live.filter((row) => failedIds.has(row.id)))}
							type="button">
							Retry
						</button>
					</div>
				)}
				<div className="flex max-h-72 flex-col overflow-y-auto py-1" onKeyDown={handleKeyDown} ref={listRef} role="group">
					{parent && <LineageRowView onOpen={() => openRow(parent)} relation="parent" row={parent} stopping={false} />}
					<LineageRowView relation="current" row={current} stopping={false} />
					{children.map((row) => (
						<div key={row.id}>
							<LineageRowView
								decisionMessage={pendingSubagentDecisions?.find((pending) => pending.taskId === row.id)?.message}
								onOpen={canOpen(row) ? () => openRow(row) : undefined}
								onStop={isStoppable(row) ? () => stop([row]) : undefined}
								relation="child"
								row={row}
								stopFailed={failedIds.has(row.id)}
								stopping={stoppingIds.has(row.id)}
							/>
							{row.tokens || row.toolCalls ? (
								<div className="pl-7 pb-1 text-[10px] text-description" data-testid="lineage-usage">
									{row.toolCalls ?? 0} tools · {(row.tokens ?? 0).toLocaleString()} tokens · $
									{(row.cost ?? 0).toFixed(4)}
								</div>
							) : null}
						</div>
					))}
					{children.length === 0 && (
						<div className="px-5 py-1 text-[11px] text-description">No subagents from this thread.</div>
					)}
				</div>
			</PopoverContent>
		</Popover>
	)
}
