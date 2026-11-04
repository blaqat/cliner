import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentToolContext } from "@cline/shared";
import type {
	CoreSessionConfig,
	SubagentModelPolicyV1,
	SubagentModelConnection,
} from "../../../types/config";
import {
	AsyncAgentRegistry,
	agentControlTools,
} from "../../../extensions/tools/team/async-agents";
import { createSessionSpawnTool } from "./spawn-tool";
import { selectSubagentModel } from "./subagent-model-policy";
const mocks = vi.hoisted(() => ({ run: vi.fn(), ctor: vi.fn() }));
vi.mock("../../orchestration/session-runtime-orchestrator", () => ({
	SessionRuntime: class {
		constructor(config: unknown) {
			mocks.ctor(config);
		}
		getMessages() {
			return [];
		}
		getAgentId() {
			return "child";
		}
		getConversationId() {
			return "conversation";
		}
		subscribeEvents() {
			return () => {};
		}
		run() {
			return mocks.run();
		}
		continue() {
			return mocks.run();
		}
		abort() {}
	},
}));
function policy(): SubagentModelPolicyV1 {
	return {
		version: 1,
		models: {
			fast: {
				id: "fast",
				name: "Fast",
				connection: {
					providerId: "openai-compatible",
					modelId: "custom",
					apiKey: "isolated",
					providerConfig: {
						providerId: "openai-compatible",
						modelId: "custom",
						apiKeyEnv: [],
					},
				},
				levels: [
					{
						id: "high",
						label: "High",
						rank: 9,
						request: { kind: "effort", value: "high" },
					},
					{
						id: "low",
						label: "Low",
						rank: 1,
						request: { kind: "effort", value: "gateway-low" },
					},
				],
			},
		},
		default: { model: "fast", level: "high" },
		allowed: [
			{ model: "fast", levels: ["high", "low"] },
			{ model: "parent", levels: ["inherit"] },
		],
		blocking: "parent-decides",
	};
}
const parent = {
	providerId: "openai-native",
	modelId: "gpt-5.4",
	reasoningEffort: "xhigh" as const,
};
function fixture(
	p: SubagentModelPolicyV1 | undefined = policy(),
	maxConcurrent?: number,
) {
	const registry = new AsyncAgentRegistry();
	const onMessage = vi.fn();
	const config: CoreSessionConfig = {
		...parent,
		systemPrompt: "test",
		cwd: "/tmp",
		enableTools: false,
		enableSpawnAgent: true,
		enableAgentTeams: false,
		subagentSettings: { modelPolicy: p, maxConcurrent },
	};
	const deps = {
		agentRegistries: new Map([["root", registry]]),
		getSession: () => undefined,
		subAgentStarts: new Map(),
		onAgentEvent: vi.fn(),
		invokeBackendOptional: async () => {},
		onSubagentMessage: onMessage,
	};
	const tool = createSessionSpawnTool(deps, config, "root");
	const input = { systemPrompt: "test", task: "work" };
	const context: AgentToolContext = { agentId: "parent", iteration: 1 };
	return {
		registry,
		onMessage,
		tool,
		input,
		context,
		call: (extra = {}, ctx = context) =>
			tool.execute({ ...input, ...extra }, ctx),
		controls: agentControlTools.get(tool)!,
	};
}
const done = {
	text: "done",
	iterations: 1,
	finishReason: "completed",
	usage: { inputTokens: 1, outputTokens: 2 },
};
beforeEach(() => {
	mocks.run.mockReset().mockResolvedValue(done);
	mocks.ctor.mockClear();
});
afterEach(() => vi.useRealTimers());
describe("versioned subagent model policy", () => {
	it("uses the lowest rank, preserves custom compatible effort, and clears inherited reasoning", async () => {
		const selected = selectSubagentModel({ model: "Fast" }, policy(), parent);
		expect(selected.reasoningEffort).toBe("low");
		expect(selected.overrides?.reasoningEffort).toBeUndefined();
		const fetch = vi.fn(
			async (_url: unknown, _init?: RequestInit) => new Response("{}"),
		);
		const p = policy();
		p.models.fast!.connection.providerConfig!.fetch =
			fetch as typeof globalThis.fetch;
		const mapped = selectSubagentModel({ model: "fast" }, p, parent);
		await (mapped.overrides as SubagentModelConnection).providerConfig!.fetch!(
			"https://test.invalid",
			{ body: JSON.stringify({ model: "custom", reasoning_effort: "xhigh" }) },
		);
		expect(
			JSON.parse(fetch.mock.calls[0]![1]!.body as string).reasoning_effort,
		).toBe("gateway-low");
	});
	it("rejects bypasses with exact corrective errors before constructing a child", async () => {
		const f = fixture();
		expect(await f.call({ model: "rogue" })).toEqual({
			error:
				'Model "rogue" is not allowed. Allowed: fast (high, low), parent (inherit). Omit model to use the default: fast at high.',
		});
		expect(await f.call({ model: "fast", reasoningEffort: "xhigh" })).toEqual({
			error:
				'Reasoning effort "xhigh" is not allowed for fast. Allowed: high, low.',
		});
		expect(await f.call({ profile: "fast" })).toEqual({
			error: "The profile parameter is no longer supported. Use model instead.",
		});
		expect(mocks.ctor).not.toHaveBeenCalled();
	});
	it("rejects ambiguous names; ids retain connection identity", () => {
		const p = policy();
		p.models.other = { ...p.models.fast!, id: "other" };
		expect(selectSubagentModel({ model: "Fast" }, p, parent).error).toBe(
			'Model name "Fast" is ambiguous. Pass the model id: Fast (fast), Fast (other).',
		);
		expect(
			selectSubagentModel({ model: "fast" }, p, parent).error,
		).toBeUndefined();
	});
	it("permits only the default when the optional allowlist is empty", () => {
		const p = policy();
		p.allowed = [];
		expect(selectSubagentModel({}, p, parent).reasoningEffort).toBe("high");
		expect(
			selectSubagentModel({ reasoningEffort: "low" }, p, parent).error,
		).toBe(
			"A model and level can't be chosen here. Omit them to use the default.",
		);
	});
	it("includes the implicit default pair and validates it before starting", () => {
		const p = policy();
		p.allowed = [{ model: "parent", levels: ["inherit"] }];
		expect(
			selectSubagentModel({ model: "fast" }, p, parent).reasoningEffort,
		).toBe("high");
		p.default.level = "removed";
		expect(selectSubagentModel({ model: "parent" }, p, parent).error).toBe(
			"Saved level is unavailable",
		);
	});
	it("rejects malformed records, missing allowed models and invalid native controls", () => {
		const p = policy();
		p.models.fast!.id = "other";
		expect(selectSubagentModel({}, p, parent).error).toBe(
			"Invalid subagent model policy.",
		);
		const missing = policy();
		missing.allowed.push({ model: "missing", levels: ["low"] });
		expect(selectSubagentModel({}, missing, parent).error).toBe(
			'Model "missing" is allowed but not configured. Open Settings > Models to fix it.',
		);
		const native = policy();
		native.models.fast!.connection = parent;
		native.default.level = "low";
		expect(selectSubagentModel({}, native, parent).error).toBe(
			"Unsupported native reasoning effort",
		);
	});
	it.each([
		"never",
		"parent-decides",
		"always",
	] as const)("publishes and executes %s blocking", async (blocking) => {
		const p = policy();
		p.blocking = blocking;
		const f = fixture(p);
		expect(
			!!(f.tool.inputSchema.properties as Record<string, unknown>).wait,
		).toBe(blocking === "parent-decides");
		expect(
			(f.tool.inputSchema.properties as Record<string, unknown>).profile,
		).toBeUndefined();
		expect(f.controls.some((t) => t.name === "wait_for_agents")).toBe(
			blocking !== "never",
		);
		const result = await f.call({ wait: blocking !== "always" });
		expect(result).toMatchObject(
			blocking === "never" ? { status: "running" } : { text: "done" },
		);
		await Promise.all([...f.registry.agents.values()].map((e) => e.completion));
		expect(f.onMessage).toHaveBeenCalledTimes(blocking === "never" ? 1 : 0);
	});
	it("rejects stale wait_for_agents execution after Never takes effect", async () => {
		const p = policy();
		const f = fixture(p);
		const wait = f.controls.find((t) => t.name === "wait_for_agents")!;
		p.blocking = "never";
		expect(await wait.execute({}, f.context)).toEqual({
			error:
				"Blocking subagents is disabled. Continue working; results arrive as messages.",
		});
	});
	it("reserves before awaits, enforces default cap on resumes, and releases after settlement", async () => {
		let release!: (value: unknown) => void;
		mocks.run.mockImplementation(
			() =>
				new Promise((resolve) => {
					release = resolve;
				}),
		);
		const f = fixture();
		const results = await Promise.all(
			Array.from({ length: 4 }, () => f.call()),
		);
		expect(results[3]).toEqual({
			error:
				"Maximum concurrent subagents (3) reached. Wait for an active subagent to finish before spawning another.",
		});
		expect(mocks.ctor).toHaveBeenCalledTimes(3);
		// Settle one child, resume it, and prove it consumes the freed slot.
		release(done);
		await [...f.registry.agents.values()][2]!.completion;
		const entry = [...f.registry.agents.values()][2]!;
		entry.completion = entry.resume("continue");
		expect(await f.call()).toMatchObject({
			error: expect.stringContaining("Maximum concurrent"),
		});
		await vi.waitFor(() => expect(mocks.run).toHaveBeenCalledTimes(4));
		release(done);
		await entry.completion;
		expect(await f.call()).toMatchObject({ status: "running" });
	});
	it.each([
		undefined,
		0,
	])("preserves unlimited legacy callers and explicit unlimited=%s", async (limit) => {
		mocks.run.mockImplementation(() => new Promise(() => {}));
		const f = fixture(limit === 0 ? policy() : undefined, limit);
		// fixture's default argument is policy; explicitly remove it for legacy path.
		if (limit === undefined) {
			const legacy = createSessionSpawnTool(
				{
					getSession: () => undefined,
					subAgentStarts: new Map(),
					onAgentEvent: () => {},
					invokeBackendOptional: async () => {},
				},
				{
					...parent,
					cwd: "/tmp",
					systemPrompt: "test",
					enableTools: false,
					enableSpawnAgent: true,
					enableAgentTeams: false,
				},
				"legacy",
			);
			for (let i = 0; i < 5; i++)
				expect(await legacy.execute(f.input, f.context)).toMatchObject({
					status: "running",
				});
			expect(
				(legacy.inputSchema.properties as Record<string, unknown>).wait,
			).toBeDefined();
		} else
			for (let i = 0; i < 5; i++)
				expect(await f.call()).toMatchObject({ status: "running" });
	});
	it("waits past five minutes with no deadline and Stop returns while retaining child tracking", async () => {
		vi.useFakeTimers();
		let release!: (value: unknown) => void;
		mocks.run.mockImplementation(
			() =>
				new Promise((resolve) => {
					release = resolve;
				}),
		);
		const p = policy();
		p.blocking = "always";
		const f = fixture(p);
		const controller = new AbortController();
		let settled = false;
		const result = Promise.resolve(
			f.call({ wait: false }, { ...f.context, signal: controller.signal }),
		).then((r) => {
			settled = true;
			return r;
		});
		await vi.advanceTimersByTimeAsync(360000);
		expect(settled).toBe(false);
		expect(f.tool.timeoutMs).toBe(300000);
		controller.abort();
		expect(await result).toEqual({
			error: "Stopped waiting for subagent. The child remains active.",
		});
		expect(f.registry.snapshot()[0]!.status).toBe("running");
		release(done);
		await f.registry.agents.values().next().value!.completion;
		expect(f.onMessage).toHaveBeenCalledTimes(1);
	});
});

it("a wait_for_agents deadline returns without terminating its child", async () => {
	vi.useFakeTimers();
	mocks.run.mockImplementation(() => new Promise(() => {}));
	const f = fixture();
	await f.call();
	const wait = f.controls.find((t) => t.name === "wait_for_agents")!;
	const result = wait.execute({ timeoutSeconds: 120 }, f.context);
	await vi.advanceTimersByTimeAsync(120001);
	expect(await result).toEqual({ agents: [] });
	expect(f.registry.snapshot()[0]!.status).toBe("running");
});

it("a resumed child cannot bypass a full cap", async () => {
	const f = fixture(policy(), 1);
	await f.call({ wait: true });
	const completed = f.registry.agents.get("a1")!;
	mocks.run.mockImplementation(() => new Promise(() => {}));
	await f.call();
	const send = f.controls.find((t) => t.name === "send_to_agent")!;
	expect(
		await send.execute({ agentId: "a1", message: "continue" }, f.context),
	).toEqual({
		error:
			"Maximum concurrent subagents (1) reached. Wait for an active subagent to finish before spawning another.",
	});
	expect(completed.status).toBe("done");
});

it("checks parent levels against its live runtime connection", () => {
	const p = policy();
	p.allowed = [{ model: "parent", levels: ["inherit", "medium"] }];
	const runtime = {
		...parent,
		knownModels: {
			"gpt-5.4": {
				id: "gpt-5.4",
				capabilities: ["reasoning" as const],
				reasoningOptions: [
					{
						type: "effort" as const,
						values: ["medium" as const, "xhigh" as const],
					},
				],
			},
		},
	};
	const selected = selectSubagentModel({ model: "parent" }, p, runtime);
	expect(selected.error).toBeUndefined();
	expect(selected.overrides?.reasoningEffort).toBe("medium");
	expect(
		selectSubagentModel({ model: "parent", reasoningEffort: "max" }, p, runtime)
			.error,
	).toBe(
		'Reasoning effort "max" is not allowed for parent. Allowed: inherit, medium.',
	);
	const changed = {
		...runtime,
		knownModels: {
			"gpt-5.4": {
				...runtime.knownModels["gpt-5.4"],
				reasoningOptions: [
					{ type: "effort" as const, values: ["xhigh" as const] },
				],
			},
		},
	};
	expect(
		selectSubagentModel(
			{ model: "parent", reasoningEffort: "medium" },
			p,
			changed,
		).error,
	).toBe("Saved level is unavailable");
});

it("a rejected default cannot reserve a concurrency slot", async () => {
	const p = policy();
	p.default.level = "missing";
	const f = fixture(p, 1);
	expect(await f.call()).toEqual({ error: "Saved level is unavailable" });
	p.default.level = "high";
	expect(await f.call({ wait: true })).toMatchObject({ text: "done" });
});

it("delivers a blocking result after six minutes without an automatic second turn", async () => {
	vi.useFakeTimers();
	let release!: (value: unknown) => void;
	mocks.run.mockImplementation(
		() =>
			new Promise((resolve) => {
				release = resolve;
			}),
	);
	const p = policy();
	p.blocking = "always";
	const f = fixture(p);
	const result = f.call();
	await vi.advanceTimersByTimeAsync(360001);
	release(done);
	expect(await result).toMatchObject({ text: "done" });
	expect(f.onMessage).not.toHaveBeenCalled();
});

it("ranks an inherited custom parent level against the actual runtime table", () => {
	const p = policy();
	p.allowed = [{ model: "parent", levels: ["inherit", "custom-low"] }];
	const runtime: SubagentModelConnection = {
		providerId: "openai-compatible",
		modelId: "custom",
		providerConfig: {
			providerId: "openai-compatible",
			modelId: "custom",
			settingsModelLevels: [
				{
					id: "custom-low",
					label: "Low",
					rank: 2,
					request: { kind: "effort", value: "gateway-low" },
				},
				{
					id: "custom-high",
					label: "High",
					rank: 20,
					request: { kind: "effort", value: "gateway-high" },
				},
			],
			settingsRequestIntent: {
				level: { kind: "effort", value: "gateway-high" },
				temperature: null,
				verbosity: null,
				maxOutputTokens: null,
				thinkingBudgetTokens: null,
				systemRole: "system",
				extraBody: {},
			},
		},
	};
	expect(selectSubagentModel({ model: "parent" }, p, runtime)).toMatchObject({
		profileId: "parent",
		reasoningEffort: "custom-low",
	});
});
