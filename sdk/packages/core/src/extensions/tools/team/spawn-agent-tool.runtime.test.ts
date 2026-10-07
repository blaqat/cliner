/**
 * Exercises spawn_agent cancellation through the real SessionRuntime and
 * AgentRuntime; only the model stream is scripted.
 */

import { createAgentRuntime } from "@cline/agents";
import type { AgentConfig, AgentModel } from "@cline/shared";
import { describe, expect, it, vi } from "vitest";
import { createDelegatedAgentConfigProvider } from "./delegated-agent";

const { streamEntered } = vi.hoisted(() => ({
	streamEntered: { resolve: undefined as (() => void) | undefined },
}));

vi.mock(
	"../../../runtime/orchestration/session-runtime-orchestrator",
	async (importOriginal) => {
		const actual =
			await importOriginal<
				typeof import("../../../runtime/orchestration/session-runtime-orchestrator")
			>();
		// A model that streams until its request signal aborts.
		const model: AgentModel = {
			async *stream(request) {
				streamEntered.resolve?.();
				await new Promise<void>((resolve) => {
					if (request.signal?.aborted) return resolve();
					request.signal?.addEventListener("abort", () => resolve(), {
						once: true,
					});
				});
				yield { type: "finish", reason: "aborted" };
			},
		};
		class ScriptedSessionRuntime extends actual.SessionRuntime {
			constructor(config: AgentConfig) {
				super(config, {
					createAgentRuntimeImpl: (runtimeConfig) =>
						createAgentRuntime({ ...runtimeConfig, model }),
				});
			}
		}
		return { ...actual, SessionRuntime: ScriptedSessionRuntime };
	},
);

function startTool(signal: AbortSignal, toolCallId: string) {
	return import("./spawn-agent-tool.js").then(({ createSpawnAgentTool }) => {
		const registry = { register: vi.fn(), unregister: vi.fn() };
		const onSubAgentEnd = vi.fn();
		const entered = new Promise<void>((resolve) => {
			streamEntered.resolve = resolve;
		});
		const tool = createSpawnAgentTool({
			configProvider: createDelegatedAgentConfigProvider({
				providerId: "anthropic",
				modelId: "mock-model",
				apiKey: "test-key",
			}),
			subAgentTools: [],
			abortHandleRegistry: registry,
			onSubAgentEnd,
		});
		const executing = tool.execute(
			{ systemPrompt: "System", task: "Do task" },
			{
				agentId: "parent-rt",
				conversationId: "conv-parent",
				iteration: 1,
				toolCallId,
				signal,
			},
		);
		return { executing, entered, registry, onSubAgentEnd };
	});
}

describe("spawn_agent cancellation through the real runtime", () => {
	it("throws when the parent run aborts mid-stream", async () => {
		const parent = new AbortController();
		const { executing, entered, registry, onSubAgentEnd } = await startTool(
			parent.signal,
			"call-rt-1",
		);
		await entered;
		parent.abort(new Error("Task cancelled"));

		await expect(executing).rejects.toThrow("Task cancelled");
		expect(registry.unregister).toHaveBeenCalledWith("call-rt-1");
		expect(onSubAgentEnd.mock.calls[0][0].error).toBeInstanceOf(Error);
		expect(onSubAgentEnd.mock.calls[0][0].result).toBeUndefined();
	});

	it("returns a stopped result when only this child's handle aborts", async () => {
		const parent = new AbortController();
		const { executing, entered, registry } = await startTool(
			parent.signal,
			"call-rt-2",
		);
		await entered;
		(registry.register.mock.calls[0][1] as AbortController).abort();

		await expect(executing).resolves.toMatchObject({
			finishReason: "aborted",
			text: "Stopped by user before finishing.",
		});
		expect(parent.signal.aborted).toBe(false);
	});
});
