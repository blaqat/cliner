import { ShieldOffIcon } from "lucide-react"
import { useId } from "react"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useAutoApproveActions } from "@/hooks/useAutoApproveActions"
import { cn } from "@/lib/utils"
import { approvalActions, summarizeApprovals } from "./approvals"

const TILE_CLASS =
	"flex h-7 min-w-0 cursor-pointer items-center justify-center rounded-xs border border-solid p-0 transition-colors duration-100 motion-reduce:transition-none focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1 focus-visible:outline-(--vscode-focusBorder)"

/** Lit: runs without asking (focus-blue tint and edge). Off: the editor's own color, a muted icon. */
const TILE_ON_CLASS = "border-(--vscode-focusBorder)/60 bg-(--vscode-focusBorder)/25 text-foreground"
const TILE_OFF_CLASS = "border-transparent bg-code text-description hover:text-foreground"

/**
 * The top of the model menu: "Auto-approve … N of 5" over the five auto-approve actions as equal
 * icon-only tiles in one row (each tile's name is its tooltip and accessible name). Each click
 * saves that setting at once. With all five on, the tiles stay blue and the count becomes an
 * error-colored shield with "All on".
 */
export function ApprovalTiles() {
	const { autoApprovalSettings } = useExtensionState()
	const { isChecked, updateAction } = useAutoApproveActions()
	const { approveAll, enabledCount, total } = summarizeApprovals(autoApprovalSettings)
	const actions = approvalActions()
	const headingId = useId()
	return (
		<div data-approve-all={approveAll || undefined} data-testid="approval-tiles">
			<div className="flex items-center gap-1.5 px-0.5 pb-1 text-[11px] text-description">
				<span aria-hidden className="codicon codicon-shield text-[12px]!" />
				<span id={headingId}>Auto-approve</span>
				{approveAll ? (
					<span className="ml-auto flex items-center gap-1 text-error" data-testid="approvals-all-on">
						<ShieldOffIcon aria-hidden size={12} />
						All on
					</span>
				) : (
					<span className="ml-auto" data-testid="approvals-count">
						{enabledCount} of {total}
					</span>
				)}
			</div>
			<div aria-labelledby={headingId} className="grid grid-cols-5 gap-[3px]" role="group">
				{actions.map((action) => {
					const on = isChecked(action)
					return (
						<Tooltip key={action.id}>
							<TooltipTrigger asChild>
								<button
									aria-label={action.label}
									aria-pressed={on}
									className={cn(TILE_CLASS, on ? TILE_ON_CLASS : TILE_OFF_CLASS)}
									data-testid={`approval-${action.id}`}
									onClick={() => void updateAction(action, !on)}
									type="button">
									<span aria-hidden className={cn("codicon text-[14px]!", action.icon)} />
								</button>
							</TooltipTrigger>
							<TooltipContent side="top">
								<span className="font-medium">{action.label}</span>
								<br />
								<span className="text-description">
									{on ? "Auto-approved · click to ask first" : "Asks first · click to auto-approve"}
								</span>
							</TooltipContent>
						</Tooltip>
					)
				})}
			</div>
		</div>
	)
}
