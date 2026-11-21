import type { AutoApprovalSettings } from "@shared/AutoApprovalSettings"
import type { McpHub } from "@/services/mcp/McpHub"
import { arePathsEqual } from "@/utils/path"

/**
 * Build SDK `toolPolicies` for tools governed by Cline's auto-approval UI.
 *
 * The SDK defaults unlisted tools to auto-approved. For tools controlled by
 * the AutoApproveBar toggles (including all MCP tools), force the SDK to call
 * `requestToolApproval`; the approval callback then evaluates the latest
 * settings and either silently approves or shows the approval UI. This keeps
 * active sessions in sync when the user toggles auto-approval mid-task.
 */
export function buildToolPolicies(
	_settings: AutoApprovalSettings,
	mcpHub?: McpHub,
): Record<string, { enabled?: boolean; autoApprove?: boolean }> {
	const policies: Record<string, { enabled?: boolean; autoApprove?: boolean }> = {
		notebook: { enabled: true, autoApprove: true },
	}

	const set = (tools: string[]) => {
		for (const tool of tools) {
			policies[tool] = { autoApprove: false }
		}
	}

	set(["read_files", "read_file", "list_files", "list_code_definition_names", "search_codebase", "search_files"])
	set(["editor", "replace_in_file", "write_to_file", "apply_patch", "delete_file"])
	set(["run_commands", "execute_command"])
	set(["fetch_web_content", "web_fetch", "web_search"])

	if (mcpHub) {
		for (const server of mcpHub.getServers()) {
			for (const tool of server.tools ?? []) {
				const sdkName = `${server.name}__${tool.name}`
				policies[sdkName] = { autoApprove: false }
			}
		}
	}

	return policies
}

/**
 * Evaluate the current UI auto-approval settings for a single SDK tool name.
 * Used both when building initial SDK policies and as a live guard in the
 * approval callback, so changes from the AutoApproveBar are respected even if
 * an SDK session was created before the toggle changed.
 */
export function isToolAutoApproved(toolName: string, settings: AutoApprovalSettings): boolean {
	if (toolName === "notebook") return true
	if (isReadTool(toolName)) {
		return !!settings.actions.readFiles
	}
	if (isEditTool(toolName)) {
		return !!settings.actions.editFiles
	}
	if (isCommandTool(toolName)) {
		return !!settings.actions.executeSafeCommands
	}
	if (isBrowserTool(toolName)) {
		return !!settings.actions.useBrowser
	}

	if (isMcpToolName(toolName)) {
		// One global toggle governs all MCP tools; there is no per-tool opt-in.
		return !!settings.actions.useMcp
	}

	return false
}

export interface ToolApprovalScope {
	settings?: AutoApprovalSettings
	/** The thread's own folder: its workspace, or its worktree. */
	cwd?: string
	/** An automation thread in a worktree: its reads must stay inside that worktree too. */
	confined?: boolean
	/**
	 * Every folder of a multi-root workspace. A thread working in one of them may edit the others
	 * without asking, as before; a thread in its own worktree only counts that worktree.
	 */
	workspaceRoots?: string[]
	/** True when every path the call names really is inside `root` (symlinks resolved); keeps that check for execution. */
	approveInside: (root: string) => boolean
}

/**
 * Whether a tool call runs without asking. The toggles say which kinds of tools may; file tools
 * are then judged by where their paths really are. An edit whose real location is outside the
 * thread's folder (directly, or through a symlink) is an external edit and always asks: no setting
 * approves those in advance. An automation thread's reads are held to its worktree the same way.
 */
export function approvesWithoutAsking(toolName: string, scope: ToolApprovalScope): boolean {
	if (!scope.settings || !isToolAutoApproved(toolName, scope.settings)) return false
	if (!isEditTool(toolName) && !(scope.confined && isReadTool(toolName))) return true
	if (!scope.cwd) return false
	if (scope.approveInside(scope.cwd)) return true
	const roots = scope.workspaceRoots ?? []
	if (scope.confined || !roots.some((root) => arePathsEqual(root, scope.cwd))) return false
	return roots.some((root) => !arePathsEqual(root, scope.cwd) && scope.approveInside(root))
}

export function isReadTool(toolName: string): boolean {
	return ["read_files", "read_file", "list_files", "list_code_definition_names", "search_codebase", "search_files"].includes(
		toolName,
	)
}

export function isEditTool(toolName: string): boolean {
	return ["editor", "replace_in_file", "write_to_file", "apply_patch", "delete_file"].includes(toolName)
}

function isCommandTool(toolName: string): boolean {
	return toolName === "run_commands" || toolName === "execute_command"
}

function isBrowserTool(toolName: string): boolean {
	return toolName === "fetch_web_content" || toolName === "web_fetch" || toolName === "web_search"
}

/** MCP tools are registered by `createMcpTools` under `serverName__toolName`. */
function isMcpToolName(toolName: string): boolean {
	const separatorIndex = toolName.indexOf("__")
	return separatorIndex > 0 && separatorIndex + 2 < toolName.length
}
