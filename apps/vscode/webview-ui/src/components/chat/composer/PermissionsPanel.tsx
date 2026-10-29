import AutoApproveMenuItem from "@/components/chat/auto-approve-menu/AutoApproveMenuItem"
import { updateAutoApproveSettings } from "@/components/chat/auto-approve-menu/AutoApproveSettingsAPI"
import { ACTION_METADATA } from "@/components/chat/auto-approve-menu/constants"
import { MENU_SEPARATOR_CLASS } from "@/components/common/menuStyles"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useAutoApproveActions } from "@/hooks/useAutoApproveActions"
import { cn } from "@/lib/utils"
import { applyPermissionPreset, matchPermissionPreset, PERMISSION_PRESETS, summarizeApprovals } from "./permissionPresets"

const LINK_CLASS =
	"cursor-pointer border-0 bg-transparent p-0 text-[11px] text-link hover:text-link-hover hover:underline focus-visible:outline focus-visible:outline-1 focus-visible:outline-(--vscode-focusBorder)"

/**
 * The permissions part of the effort popup: the four presets as a segmented row of icons, the
 * preset's name and one line under it ("Custom · N of M on" when the approvals match none), and
 * "Pick each action", which swaps the wheel for the per-action list in the same popup.
 */
export function PermissionsPanel({
	expanded,
	onToggleExpanded,
	divider,
}: {
	expanded: boolean
	onToggleExpanded: () => void
	/** A rule under the permissions, before the wheel. */
	divider: boolean
}) {
	const { autoApprovalSettings } = useExtensionState()
	const { isChecked, updateAction } = useAutoApproveActions()
	const preset = matchPermissionPreset(autoApprovalSettings)
	const { enabledCount, total } = summarizeApprovals(autoApprovalSettings)

	return (
		<div className="flex shrink-0 flex-col" data-testid="permissions-panel">
			<div
				aria-label="Permissions"
				className="grid grid-cols-4 gap-0.5 rounded-xs bg-input-background p-0.5"
				data-testid="permission-presets"
				role="radiogroup">
				{PERMISSION_PRESETS.map((candidate) => {
					const on = candidate.id === preset?.id
					const Icon = candidate.icon
					return (
						<button
							aria-checked={on}
							aria-label={candidate.name}
							className={cn(
								"flex h-6 cursor-pointer items-center justify-center rounded-xs border-0 bg-transparent p-0 hover:text-foreground focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-(--vscode-focusBorder)",
								on ? "bg-list-hover text-foreground" : "text-description",
								on && candidate.id === "full" && "text-error hover:text-error",
							)}
							data-testid={`permission-preset-${candidate.id}`}
							key={candidate.id}
							onClick={() => {
								if (!on) void updateAutoApproveSettings(applyPermissionPreset(autoApprovalSettings, candidate.id))
							}}
							role="radio"
							title={`${candidate.name}: ${candidate.description}`}
							type="button">
							<Icon size={13} />
						</button>
					)
				})}
			</div>
			<div className="px-2 pt-1.5 pb-1" data-testid="permissions-summary">
				<div className={cn("text-[12px] font-semibold", preset?.id === "full" && "text-error")}>
					{preset ? preset.name : `Custom · ${enabledCount} of ${total} on`}
				</div>
				<div className="text-[11px] text-description">
					{preset ? preset.description : "Your own mix of approvals. Pick a preset above to replace it."}{" "}
					<button
						aria-expanded={expanded}
						className={LINK_CLASS}
						data-testid="pick-each-action"
						onClick={onToggleExpanded}
						type="button">
						{expanded ? "Hide the actions" : "Pick each action"}
					</button>
				</div>
			</div>
			{expanded && (
				<div className="px-1.5 pb-1" data-testid="approvals-menu">
					{ACTION_METADATA.map((action) => (
						<AutoApproveMenuItem action={action} isChecked={isChecked} key={action.id} onToggle={updateAction} />
					))}
					<a
						className="mt-1 inline-block text-[11px] text-link hover:text-link-hover"
						href="https://docs.cline.bot/features/auto-approve#auto-approve"
						rel="noopener"
						target="_blank">
						About auto-approve
					</a>
				</div>
			)}
			{divider && <div className={MENU_SEPARATOR_CLASS} />}
		</div>
	)
}
