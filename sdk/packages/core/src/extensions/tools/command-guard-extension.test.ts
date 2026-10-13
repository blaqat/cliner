import type {
	AgentBeforeToolContext,
	AgentRuntimeStateSnapshot,
	AgentTool,
	ITelemetryService,
} from "@cline/shared";
import { describe, expect, it, vi } from "vitest";
import {
	createPlanModeCommandGuardExtension,
	PLAN_MODE_COMMAND_GUARD_EXTENSION_NAME,
} from "./command-guard-extension";

function makeSnapshot(): AgentRuntimeStateSnapshot {
	return {
		agentId: "agent-1",
		conversationId: "conv-1",
		runId: "run-1",
		status: "running",
		iteration: 2,
		messages: [],
		pendingToolCalls: [],
		usage: {
			inputTokens: 0,
			outputTokens: 0,
			totalTokens: 0,
		},
	} as unknown as AgentRuntimeStateSnapshot;
}

function makeContext(toolName: string, input: unknown): AgentBeforeToolContext {
	return {
		snapshot: makeSnapshot(),
		tool: { name: toolName } as AgentTool,
		toolCall: {
			type: "tool-call",
			toolCallId: "tool-call-1",
			toolName,
			input,
		},
		input,
	};
}

function makeTelemetryStub(): ITelemetryService {
	return {
		capture: vi.fn(),
		captureRequired: vi.fn(),
		setDistinctId: vi.fn(),
		setMetadata: vi.fn(),
		updateMetadata: vi.fn(),
		setCommonProperties: vi.fn(),
		updateCommonProperties: vi.fn(),
		isEnabled: vi.fn(() => true),
		recordCounter: vi.fn(),
		recordHistogram: vi.fn(),
		recordGauge: vi.fn(),
		flush: vi.fn(async () => {}),
		dispose: vi.fn(async () => {}),
	};
}

async function runBeforeTool(
	extension: ReturnType<typeof createPlanModeCommandGuardExtension>,
	context: AgentBeforeToolContext,
) {
	const hook = extension.hooks?.beforeTool;
	expect(hook).toBeTypeOf("function");
	return hook?.(context);
}

describe("plan-mode command-guard extension", () => {
	it("allows notebook reads and staged writes/deletes without command approval", async () => {
		const extension = createPlanModeCommandGuardExtension();
		for (const action of ["read", "write", "delete"]) {
			expect(
				await runBeforeTool(
					extension,
					makeContext("notebook", {
						action,
						name: "dev-plan",
						content: "notes",
					}),
				),
			).toBeUndefined();
		}
	});
	it("declares the hooks capability under a stable name", () => {
		const extension = createPlanModeCommandGuardExtension();
		expect(extension.name).toBe(PLAN_MODE_COMMAND_GUARD_EXTENSION_NAME);
		expect(extension.manifest.capabilities).toContain("hooks");
	});

	it("skips run_commands calls containing a file-editing command", async () => {
		const extension = createPlanModeCommandGuardExtension();
		const result = await runBeforeTool(
			extension,
			makeContext("run_commands", { commands: ["rm -rf build"] }),
		);

		expect(result?.skip).toBe(true);
		expect(result?.stop).toBeUndefined();
		expect(result?.reason).toContain("PLAN MODE");
		expect(result?.reason).toContain("`rm`");
	});

	it("rejects the whole call when any command in a batch is blocked", async () => {
		const extension = createPlanModeCommandGuardExtension();
		const result = await runBeforeTool(
			extension,
			makeContext("run_commands", {
				commands: ["git status", "echo hi > out.txt"],
			}),
		);

		expect(result?.skip).toBe(true);
		expect(result?.reason).toContain("output redirection");
	});

	it("allows read-only run_commands calls", async () => {
		const extension = createPlanModeCommandGuardExtension();
		const result = await runBeforeTool(
			extension,
			makeContext("run_commands", {
				commands: ["ls -la", "git log --oneline", "grep -rn foo src/"],
			}),
		);

		expect(result).toBeUndefined();
	});

	it("guards structured command input", async () => {
		const extension = createPlanModeCommandGuardExtension();
		const result = await runBeforeTool(
			extension,
			makeContext("run_commands", {
				commands: [{ command: "git", args: ["checkout", "main"] }],
			}),
		);

		expect(result?.skip).toBe(true);
		expect(result?.reason).toContain("`git checkout`");
	});

	it("ignores other tools", async () => {
		const extension = createPlanModeCommandGuardExtension();
		const result = await runBeforeTool(
			extension,
			makeContext("read_files", { files: [{ path: "/tmp/rm" }] }),
		);

		expect(result).toBeUndefined();
	});

	it.each([
		"bun run check-types",
		"npm run test",
		"make check",
		"bash -c 'just check'",
		"env -u HOME bun run build",
		"xargs -I ARG bun run check-types",
		"xargs -J % bun run %",
		"find . -exec bun run {} \\;",
		"parallel bun run {}",
		"timeout -s TERM 10 bun run check-types",
		'echo "$(bun run check-types)"',
		"cat <<EOF\n$(bun run check-types)\nEOF",
	])("routes %s through the existing approval policy instead of skipping execution", async (command) => {
		const result = await runBeforeTool(
			createPlanModeCommandGuardExtension(),
			makeContext("run_commands", { commands: [command] }),
		);
		expect(result).toEqual({
			policy: { autoApprove: false, requireApproval: true },
		});
	});

	it.each([
		'printf "touch /tmp/example" | xargs -I {} sh -c {}',
		"xargs sh -c",
		"xargs -J % eval %",
		"xargs -I {} python3 -c {}",
		"xargs -I {} node -e {}",
		"find . -exec sh -c {} \\;",
		"find . -execdir node -e {} \\;",
		"parallel sh -c {}",
		"parallel 'sh -c {}' ::: 'touch /tmp/example'",
	])("rejects input-driven code before requesting approval: %s", async (command) => {
		const result = await runBeforeTool(
			createPlanModeCommandGuardExtension(),
			makeContext("run_commands", { commands: [command] }),
		);
		expect(result?.skip).toBe(true);
		expect(result?.policy).toBeUndefined();
	});

	it.each([
		"xargs grep foo",
		"xargs cat",
		"find . -name x -exec cat {} \\;",
		"parallel cat {}",
	])("allows plain input-driven readers: %s", async (command) => {
		const result = await runBeforeTool(
			createPlanModeCommandGuardExtension(),
			makeContext("run_commands", { commands: [command] }),
		);
		expect(result).toBeUndefined();
	});

	it.each([
		'env -u HOME sh -c "touch file"',
		'xargs -I ARG sh -c "touch file"',
		'timeout -s TERM 10 sh -c "touch file"',
		'echo "$(touch file)"',
		'echo "`touch file`"',
		"cat <<EOF\n$(touch file)\nEOF",
		"cat <(touch file)",
		"cat >(touch file)",
	])("blocks wrapper and substitution bypasses before approval: %s", async (command) => {
		const result = await runBeforeTool(
			createPlanModeCommandGuardExtension(),
			makeContext("run_commands", { commands: [command] }),
		);
		expect(result?.skip).toBe(true);
		expect(result?.policy).toBeUndefined();
		expect(result?.reason).toContain("`touch`");
	});

	it("checks the whole batch for blocked commands before requiring approval", async () => {
		const result = await runBeforeTool(
			createPlanModeCommandGuardExtension(),
			makeContext("run_commands", {
				commands: ["bun run check-types", "npx prettier --write src"],
			}),
		);
		expect(result?.skip).toBe(true);
		expect(result?.policy).toBeUndefined();
	});

	it("does not block or request approval for the future notebook host tool", async () => {
		const result = await runBeforeTool(
			createPlanModeCommandGuardExtension(),
			makeContext("notebook", {
				action: "write",
				content: "bun run check-types; rm file",
			}),
		);
		expect(result).toBeUndefined();
	});

	it("lets the tool report its own error for unparseable input", async () => {
		const extension = createPlanModeCommandGuardExtension();
		const result = await runBeforeTool(
			extension,
			makeContext("run_commands", { bogus: 42 }),
		);

		expect(result).toBeUndefined();
	});

	it("captures block telemetry without raw command content", async () => {
		const telemetry = makeTelemetryStub();
		const extension = createPlanModeCommandGuardExtension({ telemetry });

		await runBeforeTool(
			extension,
			makeContext("run_commands", {
				commands: ["rm -rf /workspace/secret-project"],
			}),
		);

		const captured = (telemetry.capture as ReturnType<typeof vi.fn>).mock.calls
			.map((call) => call[0])
			.filter((event) => event.event === "sdk.plan_mode_command_blocked");
		expect(captured).toHaveLength(1);
		expect(captured[0].properties).toMatchObject({
			tool_name: "run_commands",
			blocked_construct: "`rm`",
			command_count: 1,
			agent_id: "agent-1",
			conversation_id: "conv-1",
			run_id: "run-1",
			iteration: 2,
			tool_call_id: "tool-call-1",
		});
		expect(JSON.stringify(captured[0].properties)).not.toContain(
			"secret-project",
		);
	});

	it("does not capture telemetry for allowed calls", async () => {
		const telemetry = makeTelemetryStub();
		const extension = createPlanModeCommandGuardExtension({ telemetry });

		await runBeforeTool(
			extension,
			makeContext("run_commands", { commands: ["ls"] }),
		);

		expect(telemetry.capture).not.toHaveBeenCalled();
	});
});
