import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalRuntimeHost } from "./local-runtime-host";
import { AsyncAgentRegistry } from "../../extensions/tools/team/async-agents";

function fixture() {
	const session = {
		agent: {
			canStartRun: vi.fn(() => true),
			notifyPendingUserMessage: vi.fn(),
		},
		runtime: {},
		status: "idle",
		aborting: false,
	};
	const host = Object.create(LocalRuntimeHost.prototype);
	Object.assign(host, {
		sessions: new Map([["root", session]]),
		agentRegistries: new Map(),
		subagentInboxes: new Map(),
		subagentWakeTimers: new Map(),
		turnsInFlight: new Map(),
		runTurn: vi.fn(async () => {}),
		emit: vi.fn(),
	});
	host.pendingPromptsController = {
		enqueue: (_id: string, input: { prompt: string }) =>
			host.runTurn({ sessionId: _id, prompt: input.prompt }),
	};
	const send = (id: string, text: string) =>
		Reflect.get(host, "queueSubagentUpdate").call(
			host,
			"root",
			"parent",
			id,
			"done",
			text,
		);
	return { host, session, send };
}
afterEach(() => vi.useRealTimers());
describe("subagent delivery", () => {
	it("debounces multiple completions into one idle parent turn", async () => {
		vi.useFakeTimers();
		const { host, send } = fixture();
		send("a1", "one");
		send("a2", "two");
		expect(host.runTurn).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1000);
		expect(host.runTurn).toHaveBeenCalledTimes(1);
		expect(host.runTurn.mock.calls[0][0].prompt).toContain('agent="a1"');
		expect(host.runTurn.mock.calls[0][0].prompt).toContain('agent="a2"');
		await vi.advanceTimersByTimeAsync(3000);
		expect(host.runTurn).toHaveBeenCalledTimes(1);
	});
	it("keeps updates queued during approval and wakes after approval resolves", async () => {
		vi.useFakeTimers();
		const { host, send, session } = fixture();
		session.status = "pending";
		send("a1", "answer");
		await vi.advanceTimersByTimeAsync(3000);
		expect(host.runTurn).not.toHaveBeenCalled();
		session.status = "idle";
		await vi.advanceTimersByTimeAsync(1000);
		expect(host.runTurn).toHaveBeenCalledTimes(1);
	});
	it("notifies an active parent and retains a batch for its iteration boundary", async () => {
		vi.useFakeTimers();
		const { host, send, session } = fixture();
		session.agent.canStartRun.mockReturnValue(false);
		send("a1", "one");
		send("a2", "two");
		await vi.advanceTimersByTimeAsync(1000);
		expect(session.agent.notifyPendingUserMessage).toHaveBeenCalledTimes(2);
		expect(host.subagentInboxes.get("root")).toHaveLength(2);
		expect(host.runTurn).not.toHaveBeenCalled();
		// The runtime's consumePendingUserMessage callback drains this same inbox.
		host.subagentInboxes.get("root").splice(0);
		session.agent.canStartRun.mockReturnValue(true);
		await vi.advanceTimersByTimeAsync(1000);
		expect(host.runTurn).not.toHaveBeenCalled();
	});
	it("disposal cancels children and removes scheduled wakes", async () => {
		vi.useFakeTimers();
		const { host, send } = fixture();
		const registry = new AsyncAgentRegistry();
		const cancel = vi.fn();
		registry.agents.set("a1", {
			agentId: "a1",
			task: "work",
			startedAt: 1,
			status: "running",
			pending: [],
			cancel,
			resume: async () => {},
		});
		host.agentRegistries.set("root", registry);
		send("a1", "one");
		Reflect.get(host, "disposeSubagents").call(host, "root");
		expect(cancel).toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(2000);
		expect(host.runTurn).not.toHaveBeenCalled();
	});
});

it("adds running-child context to a user interjection without cancelling children", async () => {
	const registry = new AsyncAgentRegistry();
	const cancel = vi.fn();
	registry.agents.set("a1", {
		agentId: "a1",
		task: "investigate",
		status: "running",
		startedAt: Date.now(),
		pending: [],
		cancel,
		resume: async () => {},
	});
	const enqueue = vi.fn();
	const host = {
		agentRegistries: new Map([["root", registry]]),
		turnsInFlight: new Map([["root", {}]]),
		getSessionOrThrow: () => ({
			agent: { canStartRun: () => false },
			status: "running",
		}),
		abort: vi.fn(async () => {}),
		pendingPromptsController: { enqueue },
	};
	await LocalRuntimeHost.prototype.runTurn.call(host as never, {
		sessionId: "root",
		prompt: "new instruction",
		delivery: "interject",
	});
	expect(enqueue.mock.calls[0][1].prompt).toContain("a1: investigate");
	expect(cancel).not.toHaveBeenCalled();
});
