import type { AgentTool } from "@cline/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CoreSessionConfig, SubagentProfileConnection } from "../../../types/config";
import { INHERIT_SUBAGENT_PROFILE, selectSubagentProfile } from "./spawn-tool";
import type { SpawnToolDeps } from "./spawn-tool";

const runMock = vi.fn();
const agentConstructorSpy = vi.fn();

vi.mock("../../orchestration/session-runtime-orchestrator", () => {
	return {
		SessionRuntime: class MockSessionRuntime {
			constructor(config: unknown) {
				agentConstructorSpy(config);
			}

			getMessages() {
				return [];
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
		subAgentStarts: new Map<string, { startedAt: number; rootSessionId: string }>(),
		onAgentEvent: vi.fn(),
		invokeBackendOptional: vi.fn(async () => {}),
	};
}

function makeConfig(overrides: Partial<CoreSessionConfig> = {}): CoreSessionConfig {
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

const FAST: SubagentProfileConnection = {
	providerId: "anthropic",
	modelId: "claude-haiku-4-5",
	apiKey: "fast-key",
	reasoningEffort: "low",
};

const DEEP: SubagentProfileConnection = {
	providerId: "openai-native",
	modelId: "gpt-5.2-codex",
	apiKey: "deep-key",
	reasoningEffort: "high",
};

const profileSettings = (overrides: Partial<CoreSessionConfig["subagentSettings"]> = {}) => ({
	profiles: { Fast: FAST, Deep: DEEP },
	allowedProfiles: ["Fast", "Deep", INHERIT_SUBAGENT_PROFILE],
	defaultProfile: "Fast",
	defaultReasoningEffort: "medium",
	...overrides,
});

const INPUT = { systemPrompt: "sub", task: "work" };
const CONTEXT = { agentId: "parent", conversationId: "conv", iteration: 1 };

async function spawnWith(config: CoreSessionConfig, input: Record<string, unknown>) {
	const { createSessionSpawnTool } = await import("./spawn-tool.js");
	runMock.mockResolvedValue({
		text: "done",
		iterations: 1,
		finishReason: "completed",
		usage: { inputTokens: 1, outputTokens: 1 },
	});
	const tool = createSessionSpawnTool(makeDeps() as SpawnToolDeps, config, "root", {
		readFile: (async () => "") as never,
		search: (async () => "") as never,
		bash: (async () => "") as never,
		editor: (async () => "") as never,
	});
	const result = await tool.execute({ ...INPUT, ...input }, CONTEXT);
	return { tool, result, child: agentConstructorSpy.mock.calls.at(-1)?.[0] as Record<string, unknown> | undefined };
}

describe("selectSubagentProfile", () => {
	it("rejects profile params when profiles are not enabled", () => {
		expect(selectSubagentProfile({ profile: "Fast" }, {}).error).toContain("not enabled");
		expect(selectSubagentProfile({ reasoningEffort: "low" }, undefined).error).toContain("not enabled");
		expect(selectSubagentProfile({}, undefined)).toEqual({});
	});

	it("rejects unlisted profiles and lists the allowed names", () => {
		const selection = selectSubagentProfile({ profile: "Rogue" }, profileSettings());
		expect(selection.error).toContain('"Rogue" is not allowed');
		expect(selection.error).toContain('"Fast"');
		expect(selection.error).toContain('"Deep"');
	});

	it("rejects an unknown reasoning effort", () => {
		expect(
			selectSubagentProfile({ profile: "Fast", reasoningEffort: "ludicrous" }, profileSettings()).error,
		).toContain("Invalid reasoningEffort");
	});

	it("resolves an allowed profile with its connection and effort", () => {
		const selection = selectSubagentProfile({ profile: "Deep" }, profileSettings());
		expect(selection.error).toBeUndefined();
		expect(selection.profileName).toBe("Deep");
		expect(selection.overrides?.providerId).toBe("openai-native");
		expect(selection.overrides?.modelId).toBe("gpt-5.2-codex");
		expect(selection.overrides?.reasoningEffort).toBe("high");
	});

	it("prefers the call's effort over profile and default", () => {
		const selection = selectSubagentProfile({ profile: "Deep", reasoningEffort: "low" }, profileSettings());
		expect(selection.overrides?.reasoningEffort).toBe("low");
	});

	it("applies the default profile when none is requested", () => {
		const selection = selectSubagentProfile({}, profileSettings());
		expect(selection.profileName).toBe("Fast");
		expect(selection.overrides?.apiKey).toBe("fast-key");
		expect(selection.overrides?.reasoningEffort).toBe("low");
	});

	it("falls back to inherit and the default effort without a default profile", () => {
		const selection = selectSubagentProfile({}, profileSettings({ defaultProfile: undefined }));
		expect(selection.profileName).toBeUndefined();
		expect(selection.overrides?.providerId).toBeUndefined();
		expect(selection.overrides?.reasoningEffort).toBe("medium");
	});

	it("treats the reserved parent profile as explicit inherit", () => {
		const selection = selectSubagentProfile({ profile: INHERIT_SUBAGENT_PROFILE }, profileSettings());
		expect(selection.error).toBeUndefined();
		expect(selection.profileName).toBe(INHERIT_SUBAGENT_PROFILE);
		expect(selection.overrides?.providerId).toBeUndefined();
	});

	it("denies an allowed-but-unconfigured default and lets the call pick another", () => {
		const selection = selectSubagentProfile({ profile: "Deep" }, profileSettings({ allowedProfiles: ["Fast"] }));
		expect(selection.error).toContain('"Deep" is not allowed');
	});
});

describe("createSessionSpawnTool profile wiring", () => {
	beforeEach(() => vi.clearAllMocks());

	it("applies the resolved profile to the spawned child's config", async () => {
		const { child } = await spawnWith(
			makeConfig({ subagentSettings: profileSettings() }),
			{ profile: "Deep" },
		);
		expect(child).toMatchObject({ providerId: "openai-native", modelId: "gpt-5.2-codex", apiKey: "deep-key" });
		expect(child?.reasoningEffort).toBe("high");
	});

	it("returns the allowlist error without spawning", async () => {
		const { result } = await spawnWith(makeConfig({ subagentSettings: profileSettings() }), {
			profile: "Rogue",
		});
		expect(result).toEqual({ error: expect.stringContaining('"Rogue" is not allowed') });
		expect(agentConstructorSpy).not.toHaveBeenCalled();
	});

	it("inherits the parent connection when no profiles are configured", async () => {
		const { child } = await spawnWith(makeConfig(), {});
		expect(child).toMatchObject({ providerId: "anthropic", modelId: "claude-sonnet-4-6" });
	});

	it("strips profile params from the schema when disabled", async () => {
		const { createSessionSpawnTool } = await import("./spawn-tool.js");
		const disabled = createSessionSpawnTool(makeDeps() as SpawnToolDeps, makeConfig(), "root");
		const props = (disabled.inputSchema.properties ?? {}) as Record<string, unknown>;
		expect(props.profile).toBeUndefined();
		expect(props.reasoningEffort).toBeUndefined();

		const enabled = createSessionSpawnTool(
			makeDeps() as SpawnToolDeps,
			makeConfig({ subagentSettings: profileSettings() }),
			"root",
		);
		const enabledProps = (enabled.inputSchema.properties ?? {}) as Record<string, { enum?: string[] }>;
		expect(enabledProps.profile?.enum).toEqual(["Fast", "Deep", INHERIT_SUBAGENT_PROFILE]);
		expect(enabled.description).toContain('"Fast"');
	});
});
