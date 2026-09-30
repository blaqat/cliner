import { describe, expect, it } from "vitest";
import {
	ASK_MODE_INSTRUCTIONS,
	buildClineSystemPrompt,
	MODE_TAG_INSTRUCTIONS,
	PLAN_MODE_INSTRUCTIONS,
	PLAN_MODE_INSTRUCTIONS_MANUAL_SWITCH,
	processWorkspaceInfo,
} from "./cline";

const BASE_OPTIONS = {
	ide: "VS Code",
	workspaceRoot: "/workspace/project",
	workspaceName: "project",
	platform: "linux",
};

describe("processWorkspaceInfo", () => {
	it("redacts URL credentials while preserving SCP-style SSH remotes", () => {
		const metadata = JSON.parse(
			processWorkspaceInfo({
				rootPath: "/workspace/project",
				associatedRemoteUrls: [
					"origin: https://user:token@github.com/cline/cline.git",
					"backup: ssh://git:secret@example.com/cline/cline.git",
					"mirror: git@github.com:cline/cline.git",
				],
			}),
		);

		expect(
			metadata.workspaces["/workspace/project"].associatedRemoteUrls,
		).toEqual([
			"origin: https://github.com/cline/cline.git",
			"backup: ssh://example.com/cline/cline.git",
			"mirror: git@github.com:cline/cline.git",
		]);
	});
});

describe("buildClineSystemPrompt mode instructions", () => {
	it("explains the user_input mode attribute in act mode", () => {
		const prompt = buildClineSystemPrompt({ ...BASE_OPTIONS, mode: "act" });
		expect(prompt).toContain(MODE_TAG_INSTRUCTIONS);
		expect(prompt).toContain('<user_input mode="...">');
		expect(prompt).toContain("<mode_notice>");
		expect(prompt).not.toContain(PLAN_MODE_INSTRUCTIONS);
	});

	it("appends the Ask-mode contract only in plan mode", () => {
		const prompt = buildClineSystemPrompt({ ...BASE_OPTIONS, mode: "plan" });
		expect(prompt).toContain(MODE_TAG_INSTRUCTIONS);
		expect(prompt).toContain(ASK_MODE_INSTRUCTIONS);
		// The mode-tag explanation precedes the ask-mode contract, matching the
		// order the CLI historically composed by hand.
		expect(prompt.indexOf(MODE_TAG_INSTRUCTIONS)).toBeLessThan(
			prompt.indexOf(ASK_MODE_INSTRUCTIONS),
		);
	});

	it("keeps run_commands available-but-read-only in the ask contract", () => {
		// Explicit product decision: run_commands is NOT removed in Ask mode
		// (it is essential for read-only investigation); the mitigation for
		// ask-mode mutations is prompting plus the command-guard hook, so the
		// contract must spell out the inspection-only usage.
		expect(ASK_MODE_INSTRUCTIONS).toContain("run_commands");
		expect(ASK_MODE_INSTRUCTIONS).toContain("read-only");
	});

	it("never instructs the model to produce a plan or prompt a mode switch", () => {
		const prompt = buildClineSystemPrompt({ ...BASE_OPTIONS, mode: "plan" });
		expect(prompt).toContain("# Ask Mode");
		expect(prompt).not.toContain("switch_to_act_mode");
		expect(prompt).not.toContain("toggle to Act");
		expect(prompt).not.toContain("Plan/Act toggle");
		// planModeSwitchTool no longer changes the contract.
		const manual = buildClineSystemPrompt({
			...BASE_OPTIONS,
			mode: "plan",
			planModeSwitchTool: false,
		});
		expect(manual).toContain(ASK_MODE_INSTRUCTIONS);
		// The legacy plan-mode export names remain as aliases.
		expect(PLAN_MODE_INSTRUCTIONS).toBe(ASK_MODE_INSTRUCTIONS);
		expect(PLAN_MODE_INSTRUCTIONS_MANUAL_SWITCH).toBe(ASK_MODE_INSTRUCTIONS);
	});

	it("explains mode tags when the mode defaults to act", () => {
		expect(buildClineSystemPrompt({ ...BASE_OPTIONS })).toContain(
			MODE_TAG_INSTRUCTIONS,
		);
	});

	it("omits plan/act instructions in YOLO while preserving caller rules", () => {
		const rules = "# Custom Rules\n\nAlways speak like a pirate.";
		const prompt = buildClineSystemPrompt({
			...BASE_OPTIONS,
			mode: "yolo",
			rules,
		});
		expect(prompt).toContain(rules);
		expect(prompt).not.toContain(MODE_TAG_INSTRUCTIONS);
		expect(prompt).not.toContain(ASK_MODE_INSTRUCTIONS);
		expect(prompt).not.toContain("# Ask / Act Modes");
		expect(prompt).not.toContain("switch_to_act_mode");
	});

	it("places caller rules before the mode instructions", () => {
		const prompt = buildClineSystemPrompt({
			...BASE_OPTIONS,
			mode: "plan",
			rules: "# Custom Rules\n\nAlways speak like a pirate.",
		});
		const rulesIndex = prompt.indexOf("Always speak like a pirate.");
		expect(rulesIndex).toBeGreaterThan(-1);
		expect(rulesIndex).toBeLessThan(prompt.indexOf(MODE_TAG_INSTRUCTIONS));
	});

	it("includes rich workspace metadata for the Cline backend parser", () => {
		const metadata = JSON.stringify({
			workspaces: {
				"/workspace/project": {
					hint: "project",
					associatedRemoteUrls: ["origin: https://github.com/cline/cline.git"],
					latestGitCommitHash: "abc123",
				},
			},
		});
		const prompt = buildClineSystemPrompt({
			...BASE_OPTIONS,
			providerId: "cline",
			metadata,
		});

		expect(prompt).toContain(`# Workspace Configuration\n${metadata}`);
	});

	it("respects an explicit override prompt without injecting mode sections", () => {
		const prompt = buildClineSystemPrompt({
			...BASE_OPTIONS,
			mode: "plan",
			overridePrompt: "You are a custom agent.",
		});
		expect(prompt).toBe("You are a custom agent.");
	});
});
