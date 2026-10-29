import type { AutoApprovalSettings } from "@shared/AutoApprovalSettings"
import { LockIcon, type LucideIcon, PencilIcon, ShieldOffIcon, TerminalIcon } from "lucide-react"
import { ACTION_METADATA } from "@/components/chat/auto-approve-menu/constants"
import type { ActionMetadata } from "@/components/chat/auto-approve-menu/types"

/** An approval type the composer's permissions control (the per-action list's rows). */
export type ApprovalActionId = Exclude<ActionMetadata["id"], "enableNotifications">

export type PermissionPresetId = "ask" | "edit" | "commands" | "full"

export interface PermissionPreset {
	id: PermissionPresetId
	name: string
	/** One line under the segmented row. */
	description: string
	icon: LucideIcon
	/** The approval types this preset turns on; every other listed type is off. */
	on: readonly ApprovalActionId[]
}

/** Approval types listed in the per-action menu, sub-actions included. */
function menuActions(actions: ActionMetadata[]): ActionMetadata[] {
	return actions.flatMap((action) => (action.subAction ? [action, ...menuActions([action.subAction])] : [action]))
}

/** Every approval type the per-action list shows, in its order. */
export function approvalActionIds(actions: ActionMetadata[] = ACTION_METADATA): ApprovalActionId[] {
	return menuActions(actions)
		.map((action) => action.id)
		.filter((id): id is ApprovalActionId => id !== "enableNotifications")
}

/**
 * The four presets, least to most trust. They map onto the per-action approval settings:
 * Ask first = none, Edit files = read + edit, Safe commands = read + edit + commands + web fetch,
 * Full access = every type (MCP tools too).
 */
export const PERMISSION_PRESETS: readonly PermissionPreset[] = [
	{ id: "ask", name: "Ask first", description: "Cline asks before every read, edit and command.", icon: LockIcon, on: [] },
	{
		id: "edit",
		name: "Edit files",
		description: "Reads and edits files without asking. Asks before commands.",
		icon: PencilIcon,
		on: ["readFiles", "editFiles"],
	},
	{
		id: "commands",
		name: "Safe commands",
		description: "Also runs safe commands (tests, builds) and fetches web pages without asking.",
		icon: TerminalIcon,
		on: ["readFiles", "editFiles", "executeSafeCommands", "useBrowser"],
	},
	{
		id: "full",
		name: "Full access",
		description: "Everything runs without asking, MCP tools included.",
		icon: ShieldOffIcon,
		on: ["readFiles", "editFiles", "executeSafeCommands", "useBrowser", "useMcp"],
	},
]

/** How many of the listed approval types are on, and whether every one is (the former YOLO / auto-approve-all). */
export function summarizeApprovals(settings: AutoApprovalSettings | undefined, actions: ActionMetadata[] = ACTION_METADATA) {
	const ids = approvalActionIds(actions)
	const enabledCount = ids.filter((id) => settings?.actions?.[id]).length
	return { enabledCount, total: ids.length, approveAll: ids.length > 0 && enabledCount === ids.length }
}

/** The preset the current approvals match exactly, or undefined ("Custom"). */
export function matchPermissionPreset(
	settings: AutoApprovalSettings | undefined,
	actions: ActionMetadata[] = ACTION_METADATA,
): PermissionPreset | undefined {
	const ids = approvalActionIds(actions)
	return PERMISSION_PRESETS.find((preset) => ids.every((id) => !!settings?.actions?.[id] === preset.on.includes(id)))
}

/** `settings` with exactly the preset's approval types on (other fields, legacy ones included, untouched). */
export function applyPermissionPreset(
	settings: AutoApprovalSettings,
	presetId: PermissionPresetId,
	actions: ActionMetadata[] = ACTION_METADATA,
): AutoApprovalSettings {
	const preset = PERMISSION_PRESETS.find((candidate) => candidate.id === presetId)
	if (!preset) return settings
	const next = { ...settings.actions }
	for (const id of approvalActionIds(actions)) {
		next[id] = preset.on.includes(id)
	}
	return { ...settings, version: (settings.version ?? 1) + 1, actions: next }
}
