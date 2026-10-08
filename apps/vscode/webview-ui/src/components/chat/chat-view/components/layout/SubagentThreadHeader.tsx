import type { ExtensionState } from "@shared/ExtensionMessage"
import type { HistoryItem } from "@shared/HistoryItem"
import { useEffect, useState } from "react"
import { HeaderIconButton } from "@/components/chat/task-header/HeaderIconButton"
import { SubagentPanelButton } from "@/components/chat/task-header/SubagentPanel"
import { SessionStatusIcon } from "@/components/inbox/SessionStatusIcon"
import { openTask, stopSubagent } from "@/components/inbox/sessionActions"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { LineageRow } from "../../utils/threadUtils"

interface Props {
	item: HistoryItem
	view: NonNullable<ExtensionState["subagentView"]>
	onOpenSubagentPreview?: (row: LineageRow) => void
}

/** Compact header of a subagent thread: back to parent, the prompt, Stop while live, and the lineage panel. */
export function SubagentThreadHeader({ item, view, onOpenSubagentPreview }: Props) {
	const live = view.status === "running" || view.status === "waiting"
	const [stopState, setStopState] = useState<"idle" | "stopping" | "failed">("idle")
	// A different subagent, or the child leaving its live state, resets the button.
	useEffect(() => setStopState("idle"), [item.id, live])
	const stop = async () => {
		setStopState("stopping")
		if (!(await stopSubagent(view.parentTaskId, item.id))) setStopState("failed")
	}
	return (
		<div className="px-4 pt-2 pb-1" data-testid="subagent-thread-header">
			<div className="flex h-7.5 items-center gap-1.5 rounded-xs border border-transparent pl-1 pr-1 bg-(--vscode-toolbar-hoverBackground)/40">
				<HeaderIconButton icon="arrow-left" label="Back to parent" onClick={() => void openTask(view.parentTaskId)} />
				<SessionStatusIcon status={view.status} />
				<Tooltip>
					<TooltipContent className="block max-w-sm p-2" side="bottom">
						<div className="line-clamp-[12] whitespace-pre-wrap break-words">{item.task}</div>
					</TooltipContent>
					<TooltipTrigger asChild>
						<div className="min-w-0 flex-1 truncate text-[13px] font-semibold text-foreground" tabIndex={0}>
							{item.task}
						</div>
					</TooltipTrigger>
				</Tooltip>
				<div className="flex shrink-0 items-center gap-0.5">
					{live && (
						<button
							aria-label="Stop subagent"
							className="flex h-5.5 items-center gap-1 rounded-xs border border-editor-group-border bg-button-secondary-background px-1.5 text-[11px] text-button-secondary-foreground cursor-pointer hover:bg-button-secondary-background-hover disabled:cursor-default disabled:opacity-60"
							disabled={stopState === "stopping"}
							onClick={() => void stop()}
							title={
								stopState === "failed"
									? "Couldn't stop this subagent. Click to retry."
									: "Stop this subagent; its parent continues"
							}
							type="button">
							<span aria-hidden className="codicon codicon-debug-stop text-[12px]" />
							{stopState === "stopping" ? "Stopping…" : stopState === "failed" ? "Retry stop" : "Stop"}
						</button>
					)}
					<SubagentPanelButton onOpenPreview={onOpenSubagentPreview} />
				</div>
			</div>
		</div>
	)
}

export function SubagentThreadFooter({ onQuote, hasReport }: { onQuote: () => void; hasReport: boolean }) {
	return (
		<div className="px-4 py-3 text-xs text-description" data-testid="subagent-read-only">
			<p className="m-0">This subagent thread is read-only. Continue the discussion in its parent chat.</p>
			<button
				className="mt-2 rounded-xs border border-editor-group-border bg-button-secondary-background px-2 py-1 text-button-secondary-foreground cursor-pointer disabled:opacity-50"
				disabled={!hasReport}
				onClick={onQuote}
				type="button">
				Quote into parent
			</button>
		</div>
	)
}
