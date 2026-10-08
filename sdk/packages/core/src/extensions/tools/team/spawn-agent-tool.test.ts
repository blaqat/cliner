import type { AgentConfig, AgentEvent } from "@cline/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDelegatedAgentConfigProvider } from "./delegated-agent";

type AgentExtension = NonNullable<AgentConfig["extensions"]>[number];

const runMock = vi.fn();
let onEvent: ((event: AgentEvent) => void) | undefined;
const getAgentIdMock = vi.fn(() => "sub-agent-1");
const getConversationIdMock = vi.fn(() => "conv-sub-1");
const agentConstructorSpy = vi.fn();

vi.mock("../../../runtime/orchestration/session-runtime-orchestrator", () => {
	return {
		SessionRuntime: class MockSessionRuntime {
			constructor(config: unknown) {
				agentConstructorSpy(config);
			}

			getMessages() {
				return [];
			}

			getAgentId(): string {
				return getAgentIdMock();
			}

			getConversationId(): string {
				return getConversationIdMock();
			}

			subscribeEvents(listener: (event: AgentEvent) => void): () => void {
				onEvent = listener;
				return () => {};
			}

			async run(input: string): Promise<unknown> {
				return runMock(input);
			}
		},
	};
});

describe("createSpawnAgentTool", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("creates a sub-agent, forwards callbacks, and returns normalized output", async () => {
		const { createSpawnAgentTool } = await import("./spawn-agent-tool.js");
		runMock.mockResolvedValue({
			text: "sub-agent result",
			iterations: 2,
			finishReason: "completed",
			usage: { inputTokens: 11, outputTokens: 7 },
		});

		const onSubAgentStart = vi.fn();
		const onSubAgentEnd = vi.fn();
		const createSubAgentTools = vi.fn().mockResolvedValue([]);
		const extensions = [
			{
				name: "sample-ext",
				manifest: { capabilities: ["hooks"] },
				hooks: { onEvent: vi.fn() },
			} as AgentExtension,
		];

		const tool = createSpawnAgentTool({
			configProvider: createDelegatedAgentConfigProvider({
				providerId: "anthropic",
				modelId: "mock-model",
				extensions,
			}),
			defaultMaxIterations: 4,
			createSubAgentTools,
			onSubAgentStart,
			onSubAgentEnd,
		});

		const output = await tool.execute(
			{
				systemPrompt: "You are focused",
				task: "Do delegated work",
			},
			{
				agentId: "parent-1",
				conversationId: "conv-parent",
				iteration: 3,
			},
		);

		expect(createSubAgentTools).toHaveBeenCalledTimes(1);
		expect(runMock).toHaveBeenCalledWith("Do delegated work");
		expect(onSubAgentStart).toHaveBeenCalledTimes(1);
		expect(onSubAgentEnd).toHaveBeenCalledTimes(1);
		expect(output).toEqual({
			text: "sub-agent result",
			iterations: 2,
			finishReason: "completed",
			usage: {
				inputTokens: 11,
				outputTokens: 7,
			},
		});
		expect(agentConstructorSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				parentAgentId: "parent-1",
				maxIterations: 4,
				extensions,
			}),
		);
		expect(agentConstructorSpy).toHaveBeenCalledWith(
			expect.not.objectContaining({
				prepareTurn: expect.anything(),
			}),
		);
	});

	it("passes extension hooks through delegated config", async () => {
		const { createSpawnAgentTool } = await import("./spawn-agent-tool.js");
		runMock.mockResolvedValue({
			text: "sub-agent result",
			iterations: 1,
			finishReason: "completed",
			usage: { inputTokens: 1, outputTokens: 1 },
		});

		const extensions = [
			{
				name: "before-start-ext",
				manifest: {
					capabilities: ["hooks"],
				},
				hooks: { beforeModel: vi.fn() },
			} as AgentExtension,
		];

		const tool = createSpawnAgentTool({
			configProvider: createDelegatedAgentConfigProvider({
				providerId: "anthropic",
				modelId: "mock-model",
				extensions,
			}),
			subAgentTools: [],
		});

		await tool.execute(
			{
				systemPrompt: "You are focused",
				task: "Do delegated work",
			},
			{
				agentId: "parent-1",
				conversationId: "conv-parent",
				iteration: 3,
			},
		);

		expect(agentConstructorSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				extensions,
			}),
		);
	});

	it("propagates sub-agent errors and still reports onSubAgentEnd", async () => {
		const { createSpawnAgentTool } = await import("./spawn-agent-tool.js");
		runMock.mockRejectedValue(new Error("sub-agent failed"));
		const onSubAgentEnd = vi.fn();

		const tool = createSpawnAgentTool({
			configProvider: createDelegatedAgentConfigProvider({
				providerId: "anthropic",
				modelId: "mock-model",
			}),
			subAgentTools: [],
			onSubAgentEnd,
		});

		await expect(
			tool.execute(
				{
					systemPrompt: "System",
					task: "Fail task",
				},
				{
					agentId: "parent-2",
					conversationId: "conv-parent",
					iteration: 1,
				},
			),
		).rejects.toThrow("sub-agent failed");

		expect(onSubAgentEnd).toHaveBeenCalledTimes(1);
		expect(onSubAgentEnd).toHaveBeenCalledWith(
			expect.objectContaining({
				parentAgentId: "parent-2",
				error: expect.any(Error),
			}),
		);
	});

	it("leaves maxIterations unset when neither input nor default is provided", async () => {
		const { createSpawnAgentTool } = await import("./spawn-agent-tool.js");
		runMock.mockResolvedValue({
			text: "sub-agent result",
			iterations: 1,
			finishReason: "completed",
			usage: { inputTokens: 1, outputTokens: 1 },
		});

		const tool = createSpawnAgentTool({
			configProvider: createDelegatedAgentConfigProvider({
				providerId: "anthropic",
				modelId: "mock-model",
			}),
			subAgentTools: [],
		});

		await tool.execute(
			{
				systemPrompt: "System",
				task: "Do task",
			},
			{
				agentId: "parent-3",
				conversationId: "conv-parent",
				iteration: 1,
			},
		);

		expect(agentConstructorSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				maxIterations: undefined,
			}),
		);
	});

	it("appends workspace metadata for cline sub-agents when missing", async () => {
		const { createSpawnAgentTool } = await import("./spawn-agent-tool.js");
		runMock.mockResolvedValue({
			text: "ok",
			iterations: 1,
			finishReason: "completed",
			usage: { inputTokens: 1, outputTokens: 1 },
		});

		const workspaceMetadata = `# Workspace Configuration
{
  "workspaces": {
    "/repo/demo": {
      "hint": "demo"
    }
  }
}`;

		const tool = createSpawnAgentTool({
			configProvider: createDelegatedAgentConfigProvider({
				providerId: "cline",
				modelId: "anthropic/claude-sonnet-4.6",
				cwd: "/repo/demo",
				workspaceMetadata,
			}),
			subAgentTools: [],
		});

		await tool.execute(
			{
				systemPrompt: "You are a specialist teammate.",
				task: "Investigate module boundaries",
			},
			{
				agentId: "parent-4",
				conversationId: "conv-parent",
				iteration: 1,
			},
		);

		expect(agentConstructorSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				systemPrompt: expect.stringContaining(workspaceMetadata),
			}),
		);
	});

	it("does not duplicate workspace metadata for cline sub-agents", async () => {
		const { createSpawnAgentTool } = await import("./spawn-agent-tool.js");
		runMock.mockResolvedValue({
			text: "ok",
			iterations: 1,
			finishReason: "completed",
			usage: { inputTokens: 1, outputTokens: 1 },
		});

		const inputSystemPrompt = `You are a specialist teammate.

# Workspace Configuration
{
  "workspaces": {
    "/repo/demo": {
      "hint": "demo"
    }
  }
}`;

		const tool = createSpawnAgentTool({
			configProvider: createDelegatedAgentConfigProvider({
				providerId: "cline",
				modelId: "anthropic/claude-sonnet-4.6",
				cwd: "/repo/demo",
				workspaceMetadata: "# Workspace Configuration\n{}",
			}),
			subAgentTools: [],
		});

		await tool.execute(
			{
				systemPrompt: inputSystemPrompt,
				task: "Investigate module boundaries",
			},
			{
				agentId: "parent-5",
				conversationId: "conv-parent",
				iteration: 1,
			},
		);

		expect(agentConstructorSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				systemPrompt: inputSystemPrompt,
			}),
		);
	});

	it("registers a per-call abort handle that aborts only that child run", async () => {
		const { createSpawnAgentTool } = await import("./spawn-agent-tool.js");
		const registry = { register: vi.fn(), unregister: vi.fn() };
		const parent = new AbortController();
		let resolveRun: ((value: unknown) => void) | undefined;
		runMock.mockImplementation(
			() => new Promise((resolve) => (resolveRun = resolve)),
		);

		const tool = createSpawnAgentTool({
			configProvider: createDelegatedAgentConfigProvider({
				providerId: "anthropic",
				modelId: "mock-model",
			}),
			subAgentTools: [],
			abortHandleRegistry: registry,
		});

		const executing = tool.execute(
			{ systemPrompt: "System", task: "Do task" },
			{
				agentId: "parent-9",
				conversationId: "conv-parent",
				iteration: 1,
				toolCallId: "call-9",
				signal: parent.signal,
			},
		);

		expect(registry.register).toHaveBeenCalledWith(
			"call-9",
			expect.any(AbortController),
		);
		const controller = registry.register.mock.calls[0][1] as AbortController;
		const childSignal = agentConstructorSpy.mock.calls[0][0]
			.abortSignal as AbortSignal;

		controller.abort();
		expect(childSignal.aborted).toBe(true);
		expect(parent.signal.aborted).toBe(false);

		resolveRun?.({
			text: "stopped",
			iterations: 1,
			finishReason: "cancelled",
			usage: { inputTokens: 0, outputTokens: 0 },
		});
		const output = (await executing) as { text: string; finishReason: string };
		expect(output.finishReason).toBe("aborted");
		expect(output.text).toBe(
			"Stopped by user before finishing. Partial output:\nstopped",
		);
		expect(registry.unregister).toHaveBeenCalledWith("call-9");
	});

	it("returns a stopped result instead of throwing when the user stops a child", async () => {
		const { createSpawnAgentTool } = await import("./spawn-agent-tool.js");
		const registry = { register: vi.fn(), unregister: vi.fn() };
		const onSubAgentEnd = vi.fn();
		const parent = new AbortController();
		runMock.mockImplementation(
			() =>
				new Promise((_, reject) =>
					agentConstructorSpy.mock.calls
						.at(-1)?.[0]
						.abortSignal?.addEventListener(
							"abort",
							() => reject(new Error("Subagent stopped by user")),
							{ once: true },
						),
				),
		);

		const tool = createSpawnAgentTool({
			configProvider: createDelegatedAgentConfigProvider({
				providerId: "anthropic",
				modelId: "mock-model",
			}),
			subAgentTools: [],
			abortHandleRegistry: registry,
			onSubAgentEnd,
		});

		const executing = tool.execute(
			{ systemPrompt: "System", task: "Do task" },
			{
				agentId: "parent-11",
				conversationId: "conv-parent",
				iteration: 1,
				toolCallId: "call-11",
				signal: parent.signal,
			},
		);
		await Promise.resolve();
		(registry.register.mock.calls[0][1] as AbortController).abort();

		await expect(executing).resolves.toMatchObject({
			text: "Stopped by user before finishing.",
			finishReason: "aborted",
		});
		expect(parent.signal.aborted).toBe(false);
		expect(onSubAgentEnd).toHaveBeenCalledWith(
			expect.objectContaining({
				toolCallId: "call-11",
				result: expect.objectContaining({ finishReason: "aborted" }),
			}),
		);
		expect(onSubAgentEnd.mock.calls[0][0].error).toBeUndefined();
		expect(registry.unregister).toHaveBeenCalledWith("call-11");
	});

	it("keeps a completed result when Stop lands while messages persist", async () => {
		const { createSpawnAgentTool } = await import("./spawn-agent-tool.js");
		const registry = { register: vi.fn(), unregister: vi.fn() };
		const onSubAgentEnd = vi.fn();
		let releasePersist: (() => void) | undefined;
		const persistGate = new Promise<void>((resolve) => {
			releasePersist = resolve;
		});
		const onSubAgentMessages = vi.fn(() => persistGate);
		runMock.mockImplementation(async () => {
			agentConstructorSpy.mock.calls
				.at(-1)?.[0]
				.onEvent?.({ type: "iteration_end", iteration: 1 });
			return {
				text: "all done",
				iterations: 1,
				finishReason: "completed",
				usage: { inputTokens: 3, outputTokens: 2 },
			};
		});

		const tool = createSpawnAgentTool({
			configProvider: createDelegatedAgentConfigProvider({
				providerId: "anthropic",
				modelId: "mock-model",
			}),
			subAgentTools: [],
			abortHandleRegistry: registry,
			onSubAgentMessages,
			onSubAgentEnd,
		});

		const executing = tool.execute(
			{ systemPrompt: "System", task: "Do task" },
			{
				agentId: "parent-12",
				conversationId: "conv-parent",
				iteration: 1,
				toolCallId: "call-12",
				signal: new AbortController().signal,
			},
		);
		await vi.waitFor(() => expect(onSubAgentMessages).toHaveBeenCalled());
		// The run has settled; its handle is already gone, so a late Stop
		// (simulated by aborting the captured controller) changes nothing.
		expect(registry.unregister).toHaveBeenCalledWith("call-12");
		(registry.register.mock.calls[0][1] as AbortController).abort();
		releasePersist?.();

		await expect(executing).resolves.toMatchObject({
			text: "all done",
			finishReason: "completed",
		});
		expect(onSubAgentEnd).toHaveBeenCalledWith(
			expect.objectContaining({
				result: expect.objectContaining({ finishReason: "completed" }),
			}),
		);
	});

	it("unregisters the abort handle before onSubAgentEnd runs", async () => {
		const { createSpawnAgentTool } = await import("./spawn-agent-tool.js");
		const registry = { register: vi.fn(), unregister: vi.fn() };
		let unregisteredBeforeEnd = false;
		runMock.mockResolvedValue({
			text: "ok",
			iterations: 1,
			finishReason: "completed",
			usage: { inputTokens: 1, outputTokens: 1 },
		});

		const tool = createSpawnAgentTool({
			configProvider: createDelegatedAgentConfigProvider({
				providerId: "anthropic",
				modelId: "mock-model",
			}),
			subAgentTools: [],
			abortHandleRegistry: registry,
			onSubAgentEnd: () => {
				unregisteredBeforeEnd = registry.unregister.mock.calls.length === 1;
			},
		});

		await tool.execute(
			{ systemPrompt: "System", task: "Do task" },
			{
				agentId: "parent-13",
				conversationId: "conv-parent",
				iteration: 1,
				toolCallId: "call-13",
			},
		);
		expect(unregisteredBeforeEnd).toBe(true);
	});

	it("throws on a parent abort even when the child resolves as aborted", async () => {
		const { createSpawnAgentTool } = await import("./spawn-agent-tool.js");
		const parent = new AbortController();
		const onSubAgentEnd = vi.fn();
		runMock.mockImplementation(
			() =>
				new Promise((resolve) =>
					agentConstructorSpy.mock.calls
						.at(-1)?.[0]
						.abortSignal?.addEventListener(
							"abort",
							() =>
								resolve({
									text: "",
									iterations: 1,
									finishReason: "aborted",
									usage: { inputTokens: 0, outputTokens: 0 },
								}),
							{ once: true },
						),
				),
		);

		const tool = createSpawnAgentTool({
			configProvider: createDelegatedAgentConfigProvider({
				providerId: "anthropic",
				modelId: "mock-model",
			}),
			subAgentTools: [],
			onSubAgentEnd,
		});

		const executing = tool.execute(
			{ systemPrompt: "System", task: "Do task" },
			{
				agentId: "parent-14",
				conversationId: "conv-parent",
				iteration: 1,
				toolCallId: "call-14",
				signal: parent.signal,
			},
		);
		await Promise.resolve();
		parent.abort(new Error("Task cancelled"));
		await expect(executing).rejects.toThrow("Task cancelled");
		expect(onSubAgentEnd).toHaveBeenCalledWith(
			expect.objectContaining({ error: expect.any(Error) }),
		);
		expect(onSubAgentEnd.mock.calls[0][0].result).toBeUndefined();
		expect(onSubAgentEnd.mock.calls[0][0].agentResult).toMatchObject({
			finishReason: "aborted",
		});
	});

	it("propagates the parent abort signal into the child run", async () => {
		const { createSpawnAgentTool } = await import("./spawn-agent-tool.js");
		const parent = new AbortController();
		runMock.mockImplementation(
			() =>
				new Promise((_, reject) =>
					agentConstructorSpy.mock.calls
						.at(-1)?.[0]
						.abortSignal?.addEventListener(
							"abort",
							() => reject(new Error("aborted")),
							{ once: true },
						),
				),
		);

		const tool = createSpawnAgentTool({
			configProvider: createDelegatedAgentConfigProvider({
				providerId: "anthropic",
				modelId: "mock-model",
			}),
			subAgentTools: [],
		});

		const executing = tool.execute(
			{ systemPrompt: "System", task: "Do task" },
			{
				agentId: "parent-10",
				conversationId: "conv-parent",
				iteration: 1,
				toolCallId: "call-10",
				signal: parent.signal,
			},
		);
		await Promise.resolve();
		parent.abort();
		await expect(executing).rejects.toThrow("aborted");
	});

	it("resolves connection settings lazily at execution time", async () => {
		const { createSpawnAgentTool } = await import("./spawn-agent-tool.js");
		runMock.mockResolvedValue({
			text: "ok",
			iterations: 1,
			finishReason: "completed",
			usage: { inputTokens: 1, outputTokens: 1 },
		});

		const configProvider = createDelegatedAgentConfigProvider({
			providerId: "cline",
			modelId: "stale-model",
			apiKey: "oauth-access-old",
			temperature: 0.3,
		});
		const updateConnectionDefaults = vi.spyOn(
			configProvider,
			"updateConnectionDefaults",
		);
		configProvider.updateConnectionDefaults({
			apiKey: "oauth-access-new",
			modelId: "updated-model",
		});

		const tool = createSpawnAgentTool({
			configProvider,
			subAgentTools: [],
		});

		await tool.execute(
			{
				systemPrompt: "System",
				task: "Do task",
			},
			{
				agentId: "parent-6",
				conversationId: "conv-parent",
				iteration: 1,
			},
		);

		expect(updateConnectionDefaults).toHaveBeenCalledTimes(1);
		expect(agentConstructorSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				apiKey: "oauth-access-new",
				modelId: "updated-model",
				temperature: 0.3,
			}),
		);
	});
});

it.each([
	"error",
	"parent cancelled",
	"stopped by user",
])("retains accumulated usage when the run throws: %s", async (ending) => {
	const { createSpawnAgentTool } = await import("./spawn-agent-tool.js");
	const parent = new AbortController();
	const registry = { register: vi.fn(), unregister: vi.fn() };
	const onSubAgentEnd = vi.fn();
	runMock.mockImplementation(async () => {
		onEvent!({
			type: "usage",
			agentId: "sub-agent-1",
			conversationId: "conv-sub-1",
			inputTokens: 1000,
			outputTokens: 20,
			cacheReadTokens: 850,
			cacheWriteTokens: 50,
			cost: 0.002,
			totalInputTokens: 1000,
			totalOutputTokens: 20,
		});
		onEvent!({
			type: "content_start",
			contentType: "tool",
			toolName: "read_files",
			agentId: "sub-agent-1",
			conversationId: "conv-sub-1",
		});
		if (ending === "parent cancelled") parent.abort(new Error("Cancelled"));
		if (ending === "stopped by user")
			registry.register.mock.calls[0][1].abort();
		throw new Error("Run failed");
	});
	const tool = createSpawnAgentTool({
		configProvider: createDelegatedAgentConfigProvider({
			providerId: "test",
			modelId: "test",
		}),
		abortHandleRegistry: registry,
		onSubAgentEnd,
	});
	const executing = tool.execute(
		{ task: "Investigate", systemPrompt: "Test" },
		{
			agentId: "parent",
			conversationId: "parent",
			iteration: 1,
			toolCallId: "spawn",
			signal: parent.signal,
		},
	);
	if (ending === "stopped by user")
		await expect(executing).resolves.toMatchObject({
			finishReason: "aborted",
			usage: { inputTokens: 1000, outputTokens: 20 },
		});
	else await expect(executing).rejects.toThrow("Run failed");
	expect(onSubAgentEnd).toHaveBeenCalledWith(
		expect.objectContaining({
			usage: {
				inputTokens: 1000,
				outputTokens: 20,
				cacheReadTokens: 850,
				cacheWriteTokens: 50,
				totalCost: 0.002,
			},
			toolCalls: 1,
		}),
	);
});
