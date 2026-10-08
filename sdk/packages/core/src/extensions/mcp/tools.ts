import { type AgentTool, createTool } from "@cline/shared";
import { defaultMcpToolNameTransform } from "./name-transform";
import type {
	CreateMcpToolsOptions,
	McpToolAnnotations,
	McpToolDescriptor,
} from "./types";

/**
 * Key under which MCP provenance is stored on `AgentTool.metadata`. Hooks and
 * gates (e.g. the Ask-mode MCP approval gate) use it to distinguish MCP tools
 * from builtins and to read the server's declared annotations.
 */
export const MCP_TOOL_METADATA_KEY = "mcp";

export interface McpToolMetadata {
	serverName: string;
	toolName: string;
	annotations?: McpToolAnnotations;
}

function defaultMcpDescription(
	serverName: string,
	tool: McpToolDescriptor,
): string {
	const base = tool.description?.trim();
	if (base) {
		return base;
	}
	return `Execute MCP tool "${tool.name}" from server "${serverName}".`;
}

export async function createMcpTools(
	options: CreateMcpToolsOptions,
): Promise<AgentTool[]> {
	const descriptors = await options.provider.listTools(options.serverName);
	const nameTransform = options.nameTransform ?? defaultMcpToolNameTransform;

	return descriptors.map((descriptor) => {
		const agentToolName = nameTransform({
			serverName: options.serverName,
			toolName: descriptor.name,
		});

		return createTool({
			name: agentToolName,
			description: defaultMcpDescription(options.serverName, descriptor),
			inputSchema: descriptor.inputSchema,
			metadata: {
				[MCP_TOOL_METADATA_KEY]: {
					serverName: options.serverName,
					toolName: descriptor.name,
					annotations: descriptor.annotations,
				} satisfies McpToolMetadata,
			},
			timeoutMs: options.timeoutMs,
			retryable: options.retryable,
			maxRetries: options.maxRetries,
			execute: async (input: unknown, context) =>
				options.provider.callTool({
					serverName: options.serverName,
					toolName: descriptor.name,
					arguments:
						input && typeof input === "object" && !Array.isArray(input)
							? (input as Record<string, unknown>)
							: undefined,
					context,
				}),
		});
	});
}
