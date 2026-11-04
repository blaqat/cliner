import type { ReactNode } from "react"
import { cn } from "@/lib/utils"
import { useSettingsShell } from "./SettingsShellContext"
import { changedRows, rowAncestors } from "./settingsRegistry"

/**
 * Finer control of the feature right above it; the feature itself stays on the page. Closed, it says
 * what's inside and how many values in it are changed, so a changed value is never out of sight.
 * Search and deep links open it by the feature's row id.
 */
export const AdvancedFold = ({ featureId, summary, children }: { featureId: string; summary: string; children: ReactNode }) => {
	const { rows, ctx, isFoldOpen, toggleFold } = useSettingsShell()
	const open = isFoldOpen(featureId)
	const changed = changedRows(rows, ctx).filter((row) => rowAncestors(rows, row).some((entry) => entry.id === featureId)).length
	const bodyId = `advanced-${featureId.replaceAll(".", "-")}`
	return (
		<div>
			<button
				aria-controls={bodyId}
				aria-expanded={open}
				className="mt-2.5 flex max-w-full cursor-pointer items-center gap-[3px] border-0 bg-transparent p-0 text-left text-[12px] text-description hover:text-foreground focus-visible:outline focus-visible:outline-1 focus-visible:outline-(--vscode-focusBorder)"
				onClick={() => toggleFold(featureId)}
				type="button">
				<span
					aria-hidden
					className={cn("codicon shrink-0 text-[12px]!", open ? "codicon-chevron-down" : "codicon-chevron-right")}
				/>
				<span className="shrink-0">Advanced</span>
				{!open && <span className="min-w-0 truncate opacity-70">{summary}</span>}
				{changed > 0 && (
					<span className="ml-[3px] shrink-0 rounded-lg bg-selection px-1.5 text-[11.5px] text-selection-foreground">
						{changed} changed
					</span>
				)}
			</button>
			{open && (
				<div className="mt-1.5 ml-[5px] min-w-0 border-l-2 border-editor-group-border pl-3.5" id={bodyId}>
					{children}
				</div>
			)}
		</div>
	)
}
