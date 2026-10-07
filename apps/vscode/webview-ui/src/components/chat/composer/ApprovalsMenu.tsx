import type { AutoApprovalSettings } from "@shared/AutoApprovalSettings"
import { ShieldAlertIcon, ShieldCheckIcon } from "lucide-react"
import { memo, useState } from "react"
import AutoApproveMenuItem from "@/components/chat/auto-approve-menu/AutoApproveMenuItem"
import { ACTION_METADATA } from "@/components/chat/auto-approve-menu/constants"
import type { ActionMetadata } from "@/components/chat/auto-approve-menu/types"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useAutoApproveActions } from "@/hooks/useAutoApproveActions"
import { cn } from "@/lib/utils"

/** Approval types listed in the menu, sub-actions included. */
function menuActions(actions: ActionMetadata[]): ActionMetadata[] {
	return actions.flatMap((action) => (action.subAction ? [action, ...menuActions([action.subAction])] : [action]))
}

/** How many of the menu's approval types are on, and whether every one is (the former YOLO / auto-approve-all). */
export function summarizeApprovals(settings: AutoApprovalSettings, actions: ActionMetadata[] = ACTION_METADATA) {
	const ids = menuActions(actions)
		.map((action) => action.id)
		.filter((id): id is keyof AutoApprovalSettings["actions"] => id !== "enableNotifications")
	const enabledCount = ids.filter((id) => settings?.actions?.[id]).length
	return { enabledCount, total: ids.length, approveAll: ids.length > 0 && enabledCount === ids.length }
}

/**
 * Bottom-bar shield next to the config pickers. Shows how many approval types run without asking and
 * turns to the warning color when all of them do. The menu edits the same auto-approval settings, through
 * the same RPC, as the former auto-approve bar above the composer.
 */
const ApprovalsMenu = () => {
	const { autoApprovalSettings } = useExtensionState()
	const { isChecked, updateAction } = useAutoApproveActions()
	const [open, setOpen] = useState(false)
	const { enabledCount, approveAll } = summarizeApprovals(autoApprovalSettings)
	const label = approveAll
		? "Auto-approve: everything runs without asking"
		: `Auto-approve: ${enabledCount} ${enabledCount === 1 ? "type" : "types"} on`
	const Icon = approveAll ? ShieldAlertIcon : ShieldCheckIcon

	return (
		<Popover onOpenChange={setOpen} open={open}>
			<PopoverTrigger asChild>
				<button
					aria-label={label}
					className={cn(
						"flex items-center gap-0.5 h-5 px-1 shrink-0 rounded-xs border-0 bg-transparent text-xs cursor-pointer hover:bg-toolbar-hover",
						approveAll ? "text-error" : open ? "text-foreground" : "text-description hover:text-foreground",
					)}
					data-approve-all={approveAll}
					data-testid="approvals-button"
					title={label}
					type="button">
					<Icon size={13} />
					<span className="tabular-nums" data-testid="approvals-count">
						{enabledCount}
					</span>
				</button>
			</PopoverTrigger>
			<PopoverContent align="start" className="w-64 max-h-[60vh] overflow-y-auto overscroll-contain" side="top">
				<div className="mb-2 text-xs text-description">
					Let Cline take these actions without asking for approval.{" "}
					<a
						className="text-link hover:text-link-hover"
						href="https://docs.cline.bot/features/auto-approve#auto-approve"
						rel="noopener"
						target="_blank">
						Docs
					</a>
				</div>
				{approveAll && (
					<div className="mb-2 text-xs text-error" data-testid="approvals-all-warning" role="status">
						Everything is auto-approved.
					</div>
				)}
				<div data-testid="approvals-menu">
					{ACTION_METADATA.map((action) => (
						<AutoApproveMenuItem action={action} isChecked={isChecked} key={action.id} onToggle={updateAction} />
					))}
				</div>
			</PopoverContent>
		</Popover>
	)
}

export default memo(ApprovalsMenu)
