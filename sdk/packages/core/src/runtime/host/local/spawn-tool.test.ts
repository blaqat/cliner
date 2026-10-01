import type { AgentTool } from "@cline/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SpawnToolDeps } from "./spawn-tool";
import type { CoreSessionConfig } from "../../../types/config";

const runMock = vi.fn();
const agentConstructorSpy = vi.fn();

vi.mock("../../orchestration/session-runtime-orchestrator", () => {
	return {
		SessionRuntime: class MockSessionRuntime {
			constructor(config: unknown) {
				agentConstructorSpy(config);
			}

			getAgentId(): string {
				return "sub-agent-1";
			}

			getConversationId(): string {
				return "conv-sub-1";
			}

			subscribeEvents(): () => void {
				return () => {};
			}

			async run(input: string): Promise<unknown> {
				return runMock(input);
			}
		},
	};
});

function makeDeps() {
	return {
		getSession: () => undefined,
		subAgentStarts: new Map<
			string,
			{ startedAt: number; rootSessionId: string }
		>(),
		onAgentEvent: vi.fn(),
		invokeBackendOptional: vi.fn(async () => {}),
	};
}

function makeConfig(
	overrides: Partial<CoreSessionConfig> = {},
): CoreSessionConfig {
	return {
		providerId: "anthropic",
		modelId: "claude-sonnet-4-6",
		apiKey: "key",
		systemPrompt: "test",
		cwd: process.cwd(),
		enableTools: true,
		enableSpawnAgent: false,
		enableAgentTeams: false,
		...overrides,
	};
}

// Minimal executors so createBuiltinTools materializes the tools under test.
const TOOL_EXECUTORS = {
	readFile: (async () => "") as never,
	search: (async () => "") as never,
	bash: (async () => "") as never,
	editor: (async () => "") as never,
};

async function childToolNames(
	config: CoreSessionConfig,
	input: { access?: "read" | "write" },
	requestToolApproval?: SpawnToolDeps["requestToolApproval"],
): Promise<string[]> {
	const { createSessionSpawnTool } = await import("./spawn-tool.js");
	runMock.mockResolvedValue({
		text: "done",
		iterations: 1,
		finishReason: "completed",
		usage: { inputTokens: 1, outputTokens: 1 },
	});
	const tool: AgentTool = createSessionSpawnTool(
		{ ...makeDeps(), requestToolApproval },
		config,
		"root-1",
		TOOL_EXECUTORS,
	);
	await tool.execute(
		{ systemPrompt: "sub", task: "work", access: input.access },
		{ agentId: "parent-1", conversationId: "conv-p", iteration: 1 },
	);
	const agentConfig = agentConstructorSpy.mock.calls.at(-1)?.[0] as {
		tools: AgentTool[];
	};
	return agentConfig.tools.map((t) => t.name);
}

describe("createSessionSpawnTool sub-agent access", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("defaults to read-only tools", async () => {
		const names = await childToolNames(makeConfig({ mode: "act" }), {});
		expect(names).toContain("read_files");
		expect(names).not.toContain("editor");
	});

	it("gives writers the editing toolset in act mode", async () => {
		const names = await childToolNames(makeConfig({ mode: "act" }), {
			access: "write",
		});
		expect(names).toContain("read_files");
		expect(names).toContain("editor");
	});

	it("downgrades write to read when the parent is in plan mode", async () => {
		const names = await childToolNames(makeConfig({ mode: "plan" }), {
			access: "write",
		});
		expect(names).toContain("read_files");
		expect(names).not.toContain("editor");
	});

	it("intersects the access preset with the parent's tool policies", async () => {
		const names = await childToolNames(
			makeConfig({
				mode: "act",
				toolPolicies: { editor: { enabled: false } },
			}),
			{ access: "write" },
		);
		expect(names).toContain("read_files");
		expect(names).not.toContain("editor");
	});
	it("keeps read access and the command guard through nested write requests", async () => {
		await childToolNames(makeConfig({ mode: "act", enableSpawnAgent: true }), {
			access: "read",
		});
		for (let depth = 0; depth < 3; depth++) {
			const child = agentConstructorSpy.mock.calls.at(-1)![0];
			expect(child.tools.map((tool: AgentTool) => tool.name)).not.toContain(
				"editor",
			);
			const guard = child.extensions.find(
				(extension: { name: string }) =>
					extension.name === "core.plan-mode-command-guard",
			);
			expect(guard).toBeDefined();
			expect(
				guard.hooks.beforeTool({
					tool: { name: "run_commands" },
					input: { commands: ["rm file.txt"] },
					snapshot: {},
					toolCall: { toolCallId: "shell" },
				}),
			).toMatchObject({ skip: true });
			const spawn = child.tools.find(
				(tool: AgentTool) => tool.name === "spawn_agent",
			);
			await spawn.execute(
				{ systemPrompt: "nested", task: "edit", access: "write" },
				{
					agentId: "child",
					conversationId: "child-conversation",
					iteration: 1,
				},
			);
		}
	});

	it("passes writer policies and routes nested approvals to the root session", async () => {
		const requestToolApproval = vi.fn(async () => ({
			approved: false,
			reason: "denied",
		}));
		const toolPolicies = { editor: { autoApprove: false } };
		await childToolNames(
			makeConfig({
				mode: "act",
				enableSpawnAgent: true,
				toolPolicies,
			}),
			{ access: "write" },
			requestToolApproval,
		);
		for (let depth = 0; depth < 3; depth++) {
			const child = agentConstructorSpy.mock.calls.at(-1)![0];
			const signal = new AbortController().signal;
			expect(child.toolPolicies).toEqual(toolPolicies);
			await expect(
				child.requestToolApproval({
					sessionId: "child-session",
					signal,
					agentId: "child",
					conversationId: "child-conversation",
					toolCallId: "edit",
					toolName: "editor",
					iteration: 1,
					input: {},
					policy: { autoApprove: false },
				}),
			).resolves.toEqual({ approved: false, reason: "denied" });
			expect(requestToolApproval).toHaveBeenLastCalledWith(
				expect.objectContaining({
					sessionId: "root-1",
					signal,
					agentId: "child",
					conversationId: "child-conversation",
				}),
			);
			await child.tools
				.find((tool: AgentTool) => tool.name === "spawn_agent")
				.execute(
					{ systemPrompt: "nested", task: "edit", access: "write" },
					{
						agentId: "child",
						conversationId: "child-conversation",
						iteration: 1,
					},
				);
		}
	});
});

describe("subagent settings enforcement", () => {
	beforeEach(() => vi.clearAllMocks());
	const input = { systemPrompt: "sub", task: "work" };
	const context = { agentId: "parent", conversationId: "conv", iteration: 1 };

	it("rejects disabled write access without constructing a child", async () => {
		const { createSessionSpawnTool } = await import("./spawn-tool.js");
		const tool = createSessionSpawnTool(
			makeDeps(),
			makeConfig({ subagentSettings: { allowWrite: false } }),
			"root",
		);
		expect(await tool.execute({ ...input, access: "write" }, context)).toEqual({
			error: expect.stringContaining("Write subagents are disabled"),
		});
		expect(agentConstructorSpy).not.toHaveBeenCalled();
	});

	it("removes shell and web tools when denied", async () => {
		const names = await childToolNames(
			makeConfig({
				subagentSettings: { allowCommands: false, allowWeb: false },
			}),
			{},
		);
		expect(names).toContain("read_files");
		expect(names).not.toContain("run_commands");
		expect(names).not.toContain("fetch_web_content");
	});

	it("inherits host tools and caps them by the parent's actual toolset", async () => {
		const { createSessionSpawnTool } = await import("./spawn-tool.js");
		const { MCP_TOOL_METADATA_KEY } = await import(
			"../../../extensions/mcp/tools.js"
		);
		const read = {
			name: "read_files",
			execute: vi.fn(),
		} as unknown as AgentTool;
		const shell = {
			name: "run_commands",
			execute: vi.fn(),
		} as unknown as AgentTool;
		const mcp = {
			name: "server__tool",
			metadata: {
				[MCP_TOOL_METADATA_KEY]: { serverName: "server", toolName: "tool" },
			},
			execute: vi.fn(),
		} as unknown as AgentTool;
		const deps = {
			...makeDeps(),
			getSession: () =>
				({ runtime: { tools: [read], extensions: [] } }) as never,
		};
		const config = makeConfig({
			mode: "act",
			extraTools: [shell, mcp],
			subagentSettings: { allowMcp: true },
		});
		runMock.mockResolvedValue({
			text: "done",
			iterations: 1,
			finishReason: "completed",
			usage: { inputTokens: 1, outputTokens: 1 },
		});
		await createSessionSpawnTool(deps, config, "root", TOOL_EXECUTORS).execute(
			{ ...input, access: "write" },
			context,
		);
		const child = agentConstructorSpy.mock.calls.at(-1)![0];
		expect(child.tools).toEqual([read, shell, mcp]);
		expect(child.tools.map((tool: AgentTool) => tool.name)).not.toContain(
			"editor",
		);
		await createSessionSpawnTool(
			deps,
			{
				...config,
				subagentSettings: { allowMcp: false, allowCommands: false },
			},
			"root",
			TOOL_EXECUTORS,
		).execute(input, context);
		expect(agentConstructorSpy.mock.calls.at(-1)![0].tools).toEqual([read]);
	});

	it("reserves concurrency atomically across nested tools and releases it after errors", async () => {
		const { createSessionSpawnTool } = await import("./spawn-tool.js");
		const deps = makeDeps();
		const config = makeConfig({
			enableSpawnAgent: true,
			subagentSettings: { maxConcurrent: 1 },
		});
		const tool = createSessionSpawnTool(deps, config, "root", TOOL_EXECUTORS);
		let rejectRun!: (error: Error) => void;
		runMock.mockImplementationOnce(
			() =>
				new Promise((_, reject) => {
					rejectRun = reject;
				}),
		);
		const first = tool.execute(input, context) as Promise<unknown>;
		await vi.waitFor(() => expect(rejectRun).toBeDefined());
		expect(await tool.execute(input, context)).toEqual({
			error: expect.stringContaining("Maximum concurrent subagents (1)"),
		});
		const nested = agentConstructorSpy.mock.calls
			.at(-1)![0]
			.tools.find((tool: AgentTool) => tool.name === "spawn_agent");
		expect(await nested.execute(input, context)).toEqual({
			error: expect.stringContaining("Maximum concurrent subagents (1)"),
		});
		const failure = expect(first).rejects.toThrow("failed");
		rejectRun(new Error("failed"));
		await failure;
		runMock.mockResolvedValue({
			text: "done",
			iterations: 1,
			finishReason: "completed",
			usage: { inputTokens: 1, outputTokens: 1 },
		});
		expect(await tool.execute(input, context)).toMatchObject({ text: "done" });
	});
});
