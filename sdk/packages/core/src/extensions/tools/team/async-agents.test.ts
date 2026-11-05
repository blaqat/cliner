import { describe, it, expect, vi } from "vitest";
import type { AgentConfig, AgentToolContext } from "@cline/shared";
import { AsyncAgentRegistry } from "./async-agents";
import { createDelegatedAgentConfigProvider } from "./delegated-agent";
import { createSpawnAgentTool } from "./spawn-agent-tool";

const state = vi.hoisted(() => ({
	configs: [] as AgentConfig[],
	run: vi.fn(),
	continued: vi.fn(),
	abort: vi.fn(),
	notify: vi.fn(),
}));
vi.mock("../../../runtime/orchestration/session-runtime-orchestrator", () => ({
	SessionRuntime: class {
		constructor(config: AgentConfig) {
			state.configs.push(config);
		}
		getAgentId() {
			return "child-runtime";
		}
		getConversationId() {
			return "child-conversation";
		}
		getMessages() {
			return [];
		}
		subscribeEvents() {
			return () => {};
		}
		run(message: string) {
			return state.run(message);
		}
		continue(message: string) {
			return state.continued(message);
		}
		abort() {
			state.abort();
		}
		notifyPendingUserMessage() {
			state.notify();
		}
	},
}));
const context: AgentToolContext = {
	agentId: "parent",
	conversationId: "parent-conversation",
	iteration: 1,
};
const result = {
	text: "finished",
	iterations: 1,
	finishReason: "completed",
	usage: { inputTokens: 1, outputTokens: 1 },
};
function setup() {
	state.configs.length = 0;
	vi.clearAllMocks();
	const registry = new AsyncAgentRegistry();
	const onMessage = vi.fn();
	const spawn = createSpawnAgentTool({
		registry,
		onMessage,
		configProvider: createDelegatedAgentConfigProvider({
			providerId: "test",
			modelId: "test",
		}),
	});
	const call = (name: string, input = {}) =>
		registry
			.tools()
			.find((t) => t.name === name)!
			.execute(input, context);
	return { registry, spawn, call, onMessage };
}
describe("async subagents", () => {
	it("returns before completion, injects parent messages and continues the same instance", async () => {
		const { registry, spawn, call, onMessage } = setup();
		let finish!: (value: unknown) => void;
		state.run.mockImplementation(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		expect(
			await spawn.execute({ task: "work", systemPrompt: "worker" }, context),
		).toEqual({ agentId: "a1", status: "running" });
		await call("send_to_agent", { agentId: "a1", message: "update?" });
		expect(state.configs[0].consumePendingUserMessage?.()).toBe(
			"Parent: update?",
		);
		expect(state.configs[0].consumePendingUserMessage?.()).toBeUndefined();
		const messageTool = state.configs[0].tools.find(
			(t) => t.name === "message_parent",
		)!;
		await messageTool.execute({ message: "working" }, context);
		expect(onMessage).toHaveBeenCalledWith(
			"a1",
			"message",
			"working",
			"parent",
		);
		finish(result);
		await registry.agents.get("a1")!.completion;
		expect(registry.snapshot()[0].status).toBe("done");
		state.continued.mockResolvedValue(result);
		await call("send_to_agent", { agentId: "a1", message: "more work" });
		await registry.agents.get("a1")!.completion;
		expect(state.continued).toHaveBeenCalledWith("Parent: more work");
		expect(state.configs).toHaveLength(1);
	});
	it("lists running agents, times out, and explicitly cancels", async () => {
		const { spawn, call, registry } = setup();
		state.run.mockReturnValue(new Promise(() => {}));
		await spawn.execute({ task: "work", systemPrompt: "worker" }, context);
		expect(await call("list_agents")).toMatchObject({
			agents: [{ agentId: "a1", status: "running" }],
		});
		expect(await call("wait_for_agents", { timeoutSeconds: 0 })).toEqual({
			agents: [],
		});
		await call("cancel_agent", { agentId: "a1" });
		expect(state.abort).toHaveBeenCalled();
		expect(registry.snapshot()[0].status).toBe("cancelled");
		expect(
			await call("send_to_agent", { agentId: "a1", message: "resume" }),
		).toHaveProperty("error");
		expect(
			await call("send_to_agent", { agentId: "unknown", message: "resume" }),
		).toHaveProperty("error");
	});
	it("reports reload-ended agents and never reuses their ids", async () => {
		const { registry, call } = setup();
		registry.restore([{ agentId: "a3", task: "old task", startedAt: 1 }]);
		expect(registry.snapshot()[0].status).toBe("ended (reloaded)");
		expect(
			await call("send_to_agent", { agentId: "a3", message: "resume" }),
		).toHaveProperty("error");
		expect(registry.nextId()).toBe("a4");
	});
});
