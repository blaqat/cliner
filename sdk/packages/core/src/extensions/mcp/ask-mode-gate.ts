/**
 * Ask-Mode MCP Approval Gate Extension
 *
 * Runtime extension registered for plan-mode ("Ask") sessions. MCP tools that
 * declare `annotations.readOnlyHint === true` run without approval; every other MCP
 * tool always requires user approval in Ask mode, even when the resolved tool
 * policy would auto-approve it. Enforcement lives in a `beforeTool` hook whose
 * policy override wins over configured policies (the agent runtime merges hook
 * policy after tool policies), matching the plan-mode command-guard pattern.
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
		return {
			policy:
				metadata.annotations?.readOnlyHint === true
					? { autoApprove: true, requireApproval: false }
					: { autoApprove: false, requireApproval: true },
		};
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
