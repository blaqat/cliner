import type { ExtensionState } from "@shared/ExtensionMessage"
import type { HistoryItem } from "@shared/HistoryItem"
import { ArrowLeftIcon } from "lucide-react"
import { SessionStatusIcon } from "@/components/inbox/SessionStatusIcon"
import { openTask, stopSubagent } from "@/components/inbox/sessionActions"

interface Props {
	item: HistoryItem
	view: NonNullable<ExtensionState["subagentView"]>
}

export function SubagentThreadHeader({ item, view }: Props) {
	return (
		<div className="mx-4 my-2 flex flex-col gap-2" data-testid="subagent-thread-header">
			<button
				className="flex w-fit items-center gap-1 border-0 bg-transparent p-0 text-link cursor-pointer"
				onClick={() => void openTask(view.parentTaskId)}
				type="button">
				<ArrowLeftIcon className="size-3" /> Back to parent
			</button>
			<div className="flex items-center gap-2">
				<SessionStatusIcon status={view.status} />
				<details className="min-w-0 flex-1 text-foreground">
					<summary className="truncate cursor-pointer" title={item.task}>
						{item.task}
					</summary>
					<div className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap break-words text-xs">{item.task}</div>
				</details>
				{(view.status === "running" || view.status === "waiting") && (
					<button
						className="rounded-xs border border-editor-group-border bg-button-secondary-background px-2 text-button-secondary-foreground cursor-pointer"
						onClick={() => void stopSubagent(view.parentTaskId, item.id)}
						type="button">
						Stop subagent
					</button>
				)}
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
