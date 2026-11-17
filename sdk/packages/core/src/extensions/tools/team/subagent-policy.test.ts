import type { AgentTool } from "@cline/shared";
import { describe, expect, it } from "vitest";
import { subagentParent } from "./subagent-policy";

describe("persisted agent ownership", () => {
	it.each([
		{ parentAgentId: "parent" },
		{ parentSessionId: "root.child" },
		{
			metadata: { runtimeOwnerTaskId: "root", parentTaskId: "old-grandchild" },
		},
		{ metadata: { isSubagent: true, parentTaskId: "parent" } },
	])("recognizes resumed children and old nested records: %j", (record) => {
		expect(subagentParent(record)).toBeTruthy();
	});
	it("keeps main and user-created aside spawn rights", () => {
		expect(subagentParent()).toBeUndefined();
		expect(
			subagentParent({ metadata: { parentTaskId: "main", forkedAtTs: 123 } }),
		).toBeUndefined();
	});
});

it("returns a tool error and lets a child continue after an old spawn call", async () => {
	const { AgentRuntime } = await import("@cline/agents");
	const { createAgentRuntimeConfig } = await import(
		"../../../runtime/config/agent-runtime-config-builder"
	);
	const { createSpawnAgentTool } = await import("./spawn-agent-tool");
	const { createDelegatedAgentConfigProvider } = await import(
		"./delegated-agent"
	);
	const { SUBAGENT_SPAWN_ERROR } = await import("./subagent-policy");
	const spawn = createSpawnAgentTool({
		configProvider: createDelegatedAgentConfigProvider({
			providerId: "test",
			modelId: "test",
		}),
	});
	let turns = 0;
	const runtime = new AgentRuntime(
		createAgentRuntimeConfig({
			agentConfig: {
				providerId: "test",
				modelId: "test",
				parentAgentId: "persisted-parent",
				systemPrompt: "Work",
				tools: [spawn as AgentTool],
			},
			parentAgentId: "persisted-parent",
			agentId: "child",
			tools: [spawn as AgentTool],
			completionPolicy: null,
			model: {
				async *stream() {
					if (++turns === 1) {
						yield {
							type: "tool-call-delta",
							toolCallId: "old-call",
							toolName: "spawn_agent",
							inputText: JSON.stringify({ task: "nest", systemPrompt: "work" }),
						};
						yield { type: "finish", reason: "tool-calls" };
					} else {
						yield { type: "text-delta", text: "Doing the work myself" };
						yield { type: "finish", reason: "stop" };
					}
				},
			},
		}),
	);
	const result = await runtime.run("Work");
	expect(result.status).toBe("completed");
	expect(result.outputText).toContain("Doing the work myself");
	expect(JSON.stringify(result.messages)).toContain(SUBAGENT_SPAWN_ERROR);
});
