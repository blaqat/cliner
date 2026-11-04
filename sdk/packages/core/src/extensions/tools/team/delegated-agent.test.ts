import type { AgentTool } from "@cline/shared";
import { describe, expect, it } from "vitest";
import {
	buildDelegatedAgentConfig,
	createDelegatedAgentConfigProvider,
} from "./delegated-agent";

describe("buildDelegatedAgentConfig", () => {
	it("inherits the parent distinctId and sessionId for telemetry grouping", () => {
		const configProvider = createDelegatedAgentConfigProvider({
			providerId: "anthropic",
			modelId: "claude-sonnet-4-5",
			distinctId: "user-123",
			sessionId: "sess-parent",
		});

		const config = buildDelegatedAgentConfig({
			kind: "subagent",
			prompt: "review the diff",
			tools: [],
			configProvider,
			parentAgentId: "agent-lead",
		});

		expect(config.distinctId).toBe("user-123");
		expect(config.sessionId).toBe("sess-parent");
		expect(config.parentAgentId).toBe("agent-lead");
	});

	it("leaves identity fields undefined when the parent has none", () => {
		const configProvider = createDelegatedAgentConfigProvider({
			providerId: "anthropic",
			modelId: "claude-sonnet-4-5",
		});

		const config = buildDelegatedAgentConfig({
			kind: "subagent",
			prompt: "review the diff",
			tools: [],
			configProvider,
		});

		expect(config.distinctId).toBeUndefined();
		expect(config.sessionId).toBeUndefined();
	});
});

it.each([
	"subagent",
	"teammate",
] as const)("removes parent tools from %s configurations", (kind) => {
	const names = [
		"spawn_agent",
		"send_to_agent",
		"cancel_agent",
		"list_agents",
		"wait_for_agents",
		"team_spawn_teammate",
		"team_run_task",
		"subagent_reviewer",
		"message_parent",
		"read_file",
	];
	const config = buildDelegatedAgentConfig({
		kind,
		prompt: "Work",
		tools: names.map((name) => ({ name }) as AgentTool),
		configProvider: createDelegatedAgentConfigProvider({
			providerId: "anthropic",
			modelId: "claude-sonnet-4-6",
		}),
		parentAgentId: "parent",
	});
	expect(config.tools.map((tool) => tool.name)).toEqual([
		"message_parent",
		"read_file",
	]);
});
