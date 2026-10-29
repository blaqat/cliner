import type { AutoApprovalSettings } from "@shared/AutoApprovalSettings"
import { ACTION_METADATA } from "@/components/chat/auto-approve-menu/constants"
import type { ActionMetadata } from "@/components/chat/auto-approve-menu/types"

/** An approval type the composer's approvals row toggles. */
export type ApprovalActionId = Exclude<ActionMetadata["id"], "enableNotifications">

/** Every approval action the row shows, sub-actions included (there are none today: five flat toggles). */
export function approvalActions(actions: ActionMetadata[] = ACTION_METADATA): ActionMetadata[] {
	return actions
		.flatMap((action) => (action.subAction ? [action, ...approvalActions([action.subAction])] : [action]))
		.filter((action) => action.id !== "enableNotifications")
}

/** How many approval types are on, and whether every one is (everything runs without asking). */
export function summarizeApprovals(settings: AutoApprovalSettings | undefined, actions: ActionMetadata[] = ACTION_METADATA) {
	const ids = approvalActions(actions).map((action) => action.id as ApprovalActionId)
	const enabledCount = ids.filter((id) => settings?.actions?.[id]).length
	return { enabledCount, total: ids.length, approveAll: ids.length > 0 && enabledCount === ids.length }
}

/** The chip's name for the approvals: "Auto-approve: all", "none", or "3 of 5". */
export function approvalsLabel(settings: AutoApprovalSettings | undefined): string {
	const { enabledCount, total, approveAll } = summarizeApprovals(settings)
	return `Auto-approve: ${approveAll ? "all" : enabledCount === 0 ? "none" : `${enabledCount} of ${total}`}`
}
