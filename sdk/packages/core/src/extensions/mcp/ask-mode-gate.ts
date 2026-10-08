/**
 * Ask-Mode MCP Approval Gate Extension
 *
 * Runtime extension registered for plan-mode ("Ask") sessions. MCP tools that
 * declare `annotations.readOnlyHint === true` run without approval; every other MCP
 * tool follows the user's configured approval policy (e.g. the "Use MCP"
 * auto-approve setting), exactly as in Act mode. The override lives in a
 * `beforeTool` hook whose policy wins over configured policies (the agent
 * runtime merges hook policy after tool policies).
 *
 * Act mode is unchanged: the gate is only registered for plan-mode sessions,
 * and mode switches rebuild the runtime so it appears/disappears with the mode.
 */

import type {
	AgentBeforeToolContext,
	AgentBeforeToolResult,
	AgentExtension,
} from "@cline/shared";
import { MCP_TOOL_METADATA_KEY, type McpToolMetadata } from "./tools";

export const ASK_MODE_MCP_GATE_EXTENSION_NAME = "core.ask-mode-mcp-gate";

export function createAskModeMcpGateExtension(): AgentExtension {
	const beforeTool = (
		context: AgentBeforeToolContext,
	): AgentBeforeToolResult | undefined => {
		const metadata = context.tool.metadata?.[MCP_TOOL_METADATA_KEY] as
			| McpToolMetadata
			| undefined;
		if (!metadata) {
			return undefined;
		}
		return metadata.annotations?.readOnlyHint === true
			? { policy: { autoApprove: true, requireApproval: false } }
			: undefined;
	};

	return {
		name: ASK_MODE_MCP_GATE_EXTENSION_NAME,
		manifest: {
			capabilities: ["hooks"],
		},
		hooks: {
			beforeTool,
		},
	};
}
