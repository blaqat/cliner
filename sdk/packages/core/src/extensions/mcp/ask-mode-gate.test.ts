import type {
	AgentBeforeToolContext,
	AgentRuntimeStateSnapshot,
	AgentTool,
	AgentToolCallPart,
} from "@cline/shared";
import { describe, expect, it } from "vitest";
import { createAskModeMcpGateExtension } from "./ask-mode-gate";
import { MCP_TOOL_METADATA_KEY } from "./tools";

function makeTool(metadata?: Record<string, unknown>): AgentTool {
	return {
		name: "server__tool",
		description: "test",
		inputSchema: { type: "object", properties: {} },
		metadata,
		execute: async () => ({}),
	};
}

function makeContext(tool: AgentTool): AgentBeforeToolContext {
	return {
		snapshot: {} as AgentRuntimeStateSnapshot,
		tool,
		toolCall: { toolName: tool.name } as AgentToolCallPart,
		input: {},
	};
}

describe("createAskModeMcpGateExtension", () => {
	const extension = createAskModeMcpGateExtension();
	const beforeTool = extension.hooks?.beforeTool;

	it("requires approval for MCP tools without readOnlyHint", () => {
		const tool = makeTool({
			[MCP_TOOL_METADATA_KEY]: { serverName: "s", toolName: "t" },
		});
		expect(beforeTool?.(makeContext(tool))).toEqual({
			policy: { autoApprove: false, requireApproval: true },
		});
	});

	it("requires approval when readOnlyHint is explicitly false", () => {
		const tool = makeTool({
			[MCP_TOOL_METADATA_KEY]: {
				serverName: "s",
				toolName: "t",
				annotations: { readOnlyHint: false },
			},
		});
		expect(beforeTool?.(makeContext(tool))).toEqual({
			policy: { autoApprove: false, requireApproval: true },
		});
	});

	it("auto-approves read-only MCP tools", () => {
		const tool = makeTool({
			[MCP_TOOL_METADATA_KEY]: {
				serverName: "s",
				toolName: "t",
				annotations: { readOnlyHint: true },
			},
		});
		expect(beforeTool?.(makeContext(tool))).toEqual({
			policy: { autoApprove: true, requireApproval: false },
		});
	});

	it("ignores non-MCP tools", () => {
		expect(beforeTool?.(makeContext(makeTool()))).toBeUndefined();
		expect(
			beforeTool?.(makeContext(makeTool({ source: "mcp" }))),
		).toBeUndefined();
	});
});
