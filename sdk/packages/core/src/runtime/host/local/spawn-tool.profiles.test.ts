import type { AgentTool } from "@cline/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
	CoreSessionConfig,
	SubagentProfileConnection,
} from "../../../types/config";
import type { SpawnToolDeps } from "./spawn-tool";
import { INHERIT_SUBAGENT_PROFILE, selectSubagentProfile } from "./spawn-tool";

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

const profileSettings = (
	overrides: Partial<CoreSessionConfig["subagentSettings"]> = {},
) => ({
	profiles: { Fast: FAST, Deep: DEEP },
	allowedProfiles: ["Fast", "Deep", INHERIT_SUBAGENT_PROFILE],
	defaultProfile: "Fast",
	defaultReasoningEffort: "medium",
	...overrides,
});

const INPUT = { systemPrompt: "sub", task: "work" };
const CONTEXT = { agentId: "parent", conversationId: "conv", iteration: 1 };

async function spawnWith(
	config: CoreSessionConfig,
	input: Record<string, unknown>,
) {
	const { createSessionSpawnTool } = await import("./spawn-tool.js");
	runMock.mockResolvedValue({
		text: "done",
		iterations: 1,
		finishReason: "completed",
		usage: { inputTokens: 1, outputTokens: 1 },
	});
	const tool = createSessionSpawnTool(
		makeDeps() as SpawnToolDeps,
		config,
		"root",
		{
			readFile: (async () => "") as never,
			search: (async () => "") as never,
			bash: (async () => "") as never,
			editor: (async () => "") as never,
		},
	);
	const result = await tool.execute({ ...INPUT, ...input }, CONTEXT);
	return {
		tool,
		result,
		child: agentConstructorSpy.mock.calls.at(-1)?.[0] as
			| Record<string, unknown>
			| undefined,
	};
}

// Two profiles share the display name "Review"; only id-b is allowed.
const idSettings = (
	overrides: Partial<CoreSessionConfig["subagentSettings"]> = {},
) => ({
	profiles: { "id-a": FAST, "id-b": DEEP, "id-c": DEEP },
	profileNames: { "id-a": "Review", "id-b": "Review", "id-c": "Solo" },
	allowedProfiles: ["id-b", INHERIT_SUBAGENT_PROFILE],
	...overrides,
});

describe("selectSubagentProfile", () => {
	it("rejects profile params when profiles are not enabled", () => {
		expect(selectSubagentProfile({ profile: "Fast" }, {}).error).toContain(
			"not enabled",
		);
		expect(
			selectSubagentProfile({ reasoningEffort: "low" }, undefined).error,
		).toContain("not enabled");
		expect(selectSubagentProfile({}, undefined)).toEqual({});
	});

	it("rejects unlisted profiles and lists the allowed names", () => {
		const selection = selectSubagentProfile(
			{ profile: "Rogue" },
			profileSettings(),
		);
		expect(selection.error).toContain('"Rogue" is not allowed');
		expect(selection.error).toContain("Fast (Fast)");
		expect(selection.error).toContain("Deep (Deep)");
	});

	it("rejects an unknown reasoning effort", () => {
		expect(
			selectSubagentProfile(
				{ profile: "Fast", reasoningEffort: "ludicrous" },
				profileSettings(),
			).error,
		).toContain("Invalid reasoningEffort");
	});

	it("resolves an allowed profile with its connection and effort", () => {
		const selection = selectSubagentProfile(
			{ profile: "Deep" },
			profileSettings(),
		);
		expect(selection.error).toBeUndefined();
		expect(selection.profileName).toBe("Deep");
		expect(selection.overrides?.providerId).toBe("openai-native");
		expect(selection.overrides?.modelId).toBe("gpt-5.2-codex");
		expect(selection.overrides?.reasoningEffort).toBe("high");
	});

	it("prefers the call's effort over profile and default", () => {
		const selection = selectSubagentProfile(
			{ profile: "Deep", reasoningEffort: "low" },
			profileSettings(),
		);
		expect(selection.overrides?.reasoningEffort).toBe("low");
	});

	it("applies the default profile when none is requested", () => {
		const selection = selectSubagentProfile({}, profileSettings());
		expect(selection.profileName).toBe("Fast");
		expect(selection.overrides?.apiKey).toBe("fast-key");
		expect(selection.overrides?.reasoningEffort).toBe("low");
	});

	it("falls back to inherit and the default effort without a default profile", () => {
		const selection = selectSubagentProfile(
			{},
			profileSettings({ defaultProfile: undefined }),
		);
		expect(selection.profileName).toBeUndefined();
		expect(selection.overrides?.providerId).toBeUndefined();
		expect(selection.overrides?.reasoningEffort).toBe("medium");
	});

	it("lets a host explicitly choose provider defaults for selected profiles", () => {
		const plain: SubagentProfileConnection = {
			providerId: "anthropic",
			modelId: "claude-x",
			apiKey: "k",
		};
		const settings = profileSettings({
			profiles: { Plain: plain },
			profilesUseProviderDefaultEffort: true,
			allowedProfiles: ["Plain", INHERIT_SUBAGENT_PROFILE],
			defaultProfile: undefined,
		});
		// Inherit (explicitly, or by omitting the profile) runs at the default effort.
		expect(
			selectSubagentProfile({ profile: INHERIT_SUBAGENT_PROFILE }, settings)
				.overrides?.reasoningEffort,
		).toBe("medium");
		expect(selectSubagentProfile({}, settings).overrides?.reasoningEffort).toBe(
			"medium",
		);
		// A profile's unset effort is the provider default.
		expect(
			selectSubagentProfile({ profile: "Plain" }, settings).overrides
				?.reasoningEffort,
		).toBeUndefined();
		expect(
			selectSubagentProfile({}, { ...settings, defaultProfile: "Plain" })
				.overrides?.reasoningEffort,
		).toBeUndefined();
	});

	it("keeps the settings effort fallback for non-extension SDK consumers", () => {
		const settings = profileSettings({
			profiles: { Plain: { providerId: "anthropic", modelId: "claude-x" } },
			allowedProfiles: ["Plain"],
			defaultProfile: "Plain",
		});
		expect(
			selectSubagentProfile({ profile: "Plain" }, settings).reasoningEffort,
		).toBe("medium");
		expect(selectSubagentProfile({}, settings).reasoningEffort).toBe("medium");
		expect(
			selectSubagentProfile(
				{ profile: "Plain", reasoningEffort: "high" },
				settings,
			).reasoningEffort,
		).toBe("high");
	});

	it("treats the reserved parent profile as explicit inherit", () => {
		const selection = selectSubagentProfile(
			{ profile: INHERIT_SUBAGENT_PROFILE },
			profileSettings(),
		);
		expect(selection.error).toBeUndefined();
		expect(selection.profileName).toBe(INHERIT_SUBAGENT_PROFILE);
		expect(selection.overrides?.providerId).toBeUndefined();
	});

	it("selects and authorizes by id, never by a duplicated name", () => {
		const byId = selectSubagentProfile({ profile: "id-b" }, idSettings());
		expect(byId.error).toBeUndefined();
		expect(byId.profileId).toBe("id-b");
		expect(byId.profileName).toBe("Review");
		expect(byId.overrides?.apiKey).toBe("deep-key");

		const byName = selectSubagentProfile({ profile: "Review" }, idSettings());
		expect(byName.overrides).toBeUndefined();
		expect(byName.error).toContain("ambiguous");
		expect(byName.error).toContain("Review (id-b)");
		expect(byName.error).not.toContain("id-a");

		const notAllowed = selectSubagentProfile({ profile: "id-a" }, idSettings());
		expect(notAllowed.error).toContain("not allowed");
		expect(notAllowed.overrides).toBeUndefined();
	});

	it("accepts a unique display name as a convenience", () => {
		const selection = selectSubagentProfile(
			{ profile: "Solo" },
			idSettings({ allowedProfiles: ["id-c"] }),
		);
		expect(selection.profileId).toBe("id-c");
		expect(selection.profileName).toBe("Solo");
		// A unique name of a profile that is not allowed stays blocked.
		expect(
			selectSubagentProfile({ profile: "Solo" }, idSettings()).error,
		).toContain("not allowed");
	});

	it("applies the default profile by id", () => {
		const selection = selectSubagentProfile(
			{},
			idSettings({ defaultProfile: "id-a" }),
		);
		expect(selection.profileId).toBe("id-a");
		expect(selection.profileName).toBe("Review");
		expect(selection.overrides?.apiKey).toBe("fast-key");
	});

	it("resolves named profiles that share one configuration at their own efforts", () => {
		// The host keys each named profile (configuration + effort) by its own id.
		const sameModel = {
			providerId: "anthropic",
			modelId: "claude-x",
			apiKey: "claude-key",
		};
		const settings = {
			profiles: {
				"p-quick": { ...sameModel, reasoningEffort: "low" as const },
				"p-think": { ...sameModel, reasoningEffort: "xhigh" as const },
				"p-plain": { ...sameModel },
			},
			profileNames: {
				"p-quick": "Claude",
				"p-think": "Claude",
				"p-plain": "Plain",
			},
			allowedProfiles: ["p-think", "p-plain"],
			defaultProfile: "p-quick",
		};
		const think = selectSubagentProfile({ profile: "p-think" }, settings);
		expect(think.profileId).toBe("p-think");
		expect(think.overrides).toMatchObject({
			modelId: "claude-x",
			apiKey: "claude-key",
			reasoningEffort: "xhigh",
		});
		// The default applies without being agent-selectable.
		const byDefault = selectSubagentProfile({}, settings);
		expect(byDefault.profileId).toBe("p-quick");
		expect(byDefault.reasoningEffort).toBe("low");
		expect(
			selectSubagentProfile({ profile: "p-quick" }, settings).error,
		).toContain("not allowed");
		// A name shared by an allowed and a disallowed profile never resolves by name.
		expect(
			selectSubagentProfile({ profile: "Claude" }, settings).error,
		).toContain("Claude (p-think)");
		// A profile at the provider default keeps the model's own effort.
		expect(
			selectSubagentProfile({ profile: "Plain" }, settings).reasoningEffort,
		).toBeUndefined();
	});

	it("denies an allowed-but-unconfigured default and lets the call pick another", () => {
		const selection = selectSubagentProfile(
			{ profile: "Deep" },
			profileSettings({ allowedProfiles: ["Fast"] }),
		);
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
		expect(child).toMatchObject({
			providerId: "openai-native",
			modelId: "gpt-5.2-codex",
			apiKey: "deep-key",
		});
		expect(child?.reasoningEffort).toBe("high");
	});

	it("returns the allowlist error without spawning", async () => {
		const { result } = await spawnWith(
			makeConfig({ subagentSettings: profileSettings() }),
			{
				profile: "Rogue",
			},
		);
		expect(result).toEqual({
			error: expect.stringContaining('"Rogue" is not allowed'),
		});
		expect(agentConstructorSpy).not.toHaveBeenCalled();
	});

	it("inherits the parent connection when no profiles are configured", async () => {
		const { child } = await spawnWith(makeConfig(), {});
		expect(child).toMatchObject({
			providerId: "anthropic",
			modelId: "claude-sonnet-4-6",
		});
	});

	it("strips profile params from the schema when disabled", async () => {
		const { createSessionSpawnTool } = await import("./spawn-tool.js");
		const disabled = createSessionSpawnTool(
			makeDeps() as SpawnToolDeps,
			makeConfig(),
			"root",
		);
		const props = (disabled.inputSchema.properties ?? {}) as Record<
			string,
			unknown
		>;
		expect(props.profile).toBeUndefined();
		expect(props.reasoningEffort).toBeUndefined();

		const enabled = createSessionSpawnTool(
			makeDeps() as SpawnToolDeps,
			makeConfig({ subagentSettings: profileSettings() }),
			"root",
		);
		const enabledProps = (enabled.inputSchema.properties ?? {}) as Record<
			string,
			{ enum?: string[] }
		>;
		expect(enabledProps.profile?.enum).toEqual([
			"Fast",
			"Deep",
			INHERIT_SUBAGENT_PROFILE,
		]);
		expect(enabled.description).toContain("Fast (Fast)");
	});

	it("lists duplicate names as name (id) and enumerates ids only", async () => {
		const { createSessionSpawnTool } = await import("./spawn-tool.js");
		const tool = createSessionSpawnTool(
			makeDeps() as SpawnToolDeps,
			makeConfig({ subagentSettings: idSettings() }),
			"root",
		);
		const props = (tool.inputSchema.properties ?? {}) as Record<
			string,
			{ enum?: string[]; description?: string }
		>;
		expect(props.profile?.enum).toEqual(["id-b", INHERIT_SUBAGENT_PROFILE]);
		expect(props.profile?.description).toContain("Review (id-b)");
		expect(tool.description).toContain("Review (id-b)");
	});

	it("spawns on the allowed duplicate's credentials when selected by id", async () => {
		const { child } = await spawnWith(
			makeConfig({ subagentSettings: idSettings() }),
			{ profile: "id-b" },
		);
		expect(child).toMatchObject({
			apiKey: "deep-key",
			providerId: "openai-native",
		});
	});

	it("refuses a duplicated name rather than borrowing the other profile's credentials", async () => {
		const { result } = await spawnWith(
			makeConfig({ subagentSettings: idSettings() }),
			{ profile: "Review" },
		);
		expect(result).toEqual({ error: expect.stringContaining("Review (id-b)") });
		expect(agentConstructorSpy).not.toHaveBeenCalled();
	});
});
