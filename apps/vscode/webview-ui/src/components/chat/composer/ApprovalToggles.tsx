import { ShieldOffIcon } from "lucide-react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useAutoApproveActions } from "@/hooks/useAutoApproveActions"
import { cn } from "@/lib/utils"
import { approvalActions, summarizeApprovals } from "./approvals"

const TOGGLE_CLASS =
	"flex h-5 cursor-pointer items-center gap-1 rounded-xs border-0 bg-transparent px-1 text-[11px] focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-(--vscode-focusBorder)"

/**
 * The auto-approve actions as one compact row of independent toggles (icon + short name), on a
 * light composer-colored pill; it wraps into two rows when the window is narrow. Each click
 * changes that setting at once. With every action on, the on toggles and a leading shield turn
 * error-colored: everything runs without asking.
 */
export function ApprovalToggles() {
	const { autoApprovalSettings } = useExtensionState()
	const { isChecked, updateAction } = useAutoApproveActions()
	const { approveAll } = summarizeApprovals(autoApprovalSettings)
	return (
		<div
			aria-label="Auto-approve"
			className="flex max-w-full flex-wrap items-center gap-0.5 rounded-xs bg-input-background px-0.5"
			data-approve-all={approveAll || undefined}
			data-testid="approval-toggles"
			role="group">
			{approveAll ? (
				<ShieldOffIcon
					aria-label="Everything is auto-approved"
					className="mx-0.5 shrink-0 text-error"
					data-testid="approvals-all-on"
					role="img"
					size={12}
				/>
			) : (
				<span aria-hidden className="codicon codicon-shield mx-0.5 text-[12px]! text-description" />
			)}
			{approvalActions().map((action) => {
				const on = isChecked(action)
				return (
					<button
						aria-pressed={on}
						className={cn(
							TOGGLE_CLASS,
							on
								? approveAll
									? "bg-toolbar-hover text-error"
									: "bg-toolbar-hover text-foreground"
								: "text-description opacity-75 hover:text-foreground hover:opacity-100",
						)}
						data-testid={`approval-${action.id}`}
						key={action.id}
						onClick={() => void updateAction(action, !on)}
						title={`${action.label}: ${on ? "auto-approved (click to ask first)" : "asks first (click to auto-approve)"}`}
						type="button">
						<span aria-hidden className={cn("codicon text-[11px]!", action.icon)} />
						{action.shortName}
					</button>
				)
			})}
		</div>
	)
}
