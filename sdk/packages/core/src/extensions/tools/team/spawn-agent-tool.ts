/**
 * Reusable spawn_agent tool for delegating tasks to sub-agents.
 */

import {
	type AgentConfig,
	type AgentEvent,
	type AgentHooks,
	type AgentResult,
	type AgentTool,
	type AgentToolContext,
	type BasicLogger,
	createTool,
	type HookErrorMode,
	type ITelemetryService,
	type ToolApprovalRequest,
	type ToolApprovalResult,
	type ToolPolicy,
	zodToJsonSchema,
} from "@cline/shared";
import { z } from "zod";
import {
	createDelegatedAgent,
	type DelegatedAgentConfigProvider,
} from "./delegated-agent";

type AgentExtension = NonNullable<AgentConfig["extensions"]>[number];
type AgentFinishReason = AgentResult["finishReason"];

export const SpawnAgentInputSchema = z.object({
	systemPrompt: z
		.string()
		.describe("System prompt defining the sub-agent's behavior"),
	task: z.string().describe("Task for the sub-agent to complete"),
	access: z
		.enum(["read", "write"])
		.optional()
		.describe(
			'Tool access for the sub-agent: "read" (default) gives it read-only investigation tools; "write" gives it the full editing toolset. Choose "write" only when the task requires the sub-agent to modify files. A write request is downgraded to read when the parent is in a read-only mode, and the child never receives tools the parent lacks.',
		),
});

export type SpawnAgentInput = z.infer<typeof SpawnAgentInputSchema>;

export interface SpawnAgentOutput {
	text: string;
	iterations: number;
	finishReason: AgentFinishReason;
	usage: {
		inputTokens: number;
		outputTokens: number;
	};
}

export interface SubAgentStartContext {
	subAgentId: string;
	conversationId: string;
	parentAgentId: string;
	input: SpawnAgentInput;
}

export interface SubAgentEndContext {
	subAgentId: string;
	conversationId: string;
	parentAgentId: string;
	input: SpawnAgentInput;
	result?: SpawnAgentOutput;
	agentResult?: AgentResult;
	error?: Error;
}

/**
 * Registry hook for per-call abort handles. When provided, the spawn_agent
 * tool registers one AbortController per in-flight sub-agent run (keyed by
 * the spawn_agent tool call id) so a host can stop a single child without
 * aborting the parent run. Entries are removed when the run settles.
 */
export interface SpawnAgentAbortRegistry {
	register(toolCallId: string, controller: AbortController): void;
	unregister(toolCallId: string): void;
}

export interface SpawnAgentToolConfig {
	configProvider: DelegatedAgentConfigProvider;
	defaultMaxIterations?: number;
	subAgentTools?: AgentTool[];
	createSubAgentExtensions?: (input: SpawnAgentInput) => AgentExtension[];
	createSubAgentTools?: (
		input: SpawnAgentInput,
		context: AgentToolContext,
	) => AgentTool[] | Promise<AgentTool[]>;
	onSubAgentEvent?: (event: AgentEvent) => void;
	/**
	 * Lifecycle hooks forwarded to spawned sub-agent runs.
	 */
	hooks?: AgentHooks;
	/**
	 * Extension list forwarded to spawned sub-agent runs.
	 */
	extensions?: AgentExtension[];
	/**
	 * Error handling mode for forwarded lifecycle hooks.
	 */
	hookErrorMode?: HookErrorMode;
	/**
	 * Called after a sub-agent instance is created and before it starts running.
	 * Errors are ignored so lifecycle observers cannot break task execution.
	 */
	onSubAgentStart?: (context: SubAgentStartContext) => void | Promise<void>;
	/**
	 * Called once a sub-agent run finishes (success or error).
	 * Errors are ignored so lifecycle observers cannot break task execution.
	 */
	onSubAgentEnd?: (context: SubAgentEndContext) => void | Promise<void>;
	/**
	 * Optional per-call abort registry; see {@link SpawnAgentAbortRegistry}.
	 */
	abortHandleRegistry?: SpawnAgentAbortRegistry;
	/**
	 * Optional per-tool policy for spawned sub-agents.
	 */
	toolPolicies?: Record<string, ToolPolicy>;
	/**
	 * Optional approval callback for spawned sub-agent tool calls.
	 */
	requestToolApproval?: (
		request: ToolApprovalRequest,
	) => Promise<ToolApprovalResult> | ToolApprovalResult;
	/**
	 * Optional logger forwarded to spawned sub-agent runs.
	 */
	logger?: BasicLogger;
	telemetry?: ITelemetryService;
}

/**
 * Create a spawn_agent tool that can run a delegated task with a focused sub-agent.
 */
export function createSpawnAgentTool(
	config: SpawnAgentToolConfig,
): AgentTool<SpawnAgentInput, SpawnAgentOutput> {
	return createTool<SpawnAgentInput, SpawnAgentOutput>({
		name: "spawn_agent",
		executionMode: "parallel",
		description: `Spawn a sub-agent with custom instructions for a specialized task. Waits for the sub-agent to finish and returns its result before your next step. Set access="write" when the task requires the sub-agent to edit files or make changes; leave it at the default "read" for investigation, search, and analysis tasks. A write-capable sub-agent is downgraded to read-only when you are in a read-only mode.`,
		inputSchema: zodToJsonSchema(SpawnAgentInputSchema),
		execute: async (input, context) => {
			const tools = config.createSubAgentTools
				? await config.createSubAgentTools(input, context)
				: (config.subAgentTools ?? []);

			// A per-call abort handle lets a host stop this one child without
			// aborting the parent run; it still follows the parent's signal.
			const toolCallId = context.toolCallId;
			const abortController = new AbortController();
			if (toolCallId) {
				config.abortHandleRegistry?.register(toolCallId, abortController);
			}
			const abortSignal = context.signal
				? AbortSignal.any([context.signal, abortController.signal])
				: abortController.signal;

			const subAgent = createDelegatedAgent({
				kind: "subagent",
				prompt: input.systemPrompt,
				configProvider: {
					...config.configProvider,
					getRuntimeConfig: () => {
						const runtime = config.configProvider.getRuntimeConfig();
						return {
							...runtime,
							extensions:
								config.createSubAgentExtensions?.(input) ?? runtime.extensions,
						};
					},
				},
				tools,
				maxIterations: config.defaultMaxIterations,
				parentAgentId: context.agentId,
				abortSignal,
				onEvent: config.onSubAgentEvent,
				hookErrorMode: config.hookErrorMode,
				toolPolicies: config.toolPolicies,
				requestToolApproval: config.requestToolApproval,
			});
			const subAgentId = subAgent.getAgentId();
			const conversationId = subAgent.getConversationId();
			const parentAgentId = context.agentId;
			if (config.onSubAgentStart) {
				try {
					await config.onSubAgentStart({
						subAgentId,
						conversationId,
						parentAgentId,
						input,
					});
				} catch {
					// Best-effort observer callback.
				}
			}
			try {
				const result = await subAgent.run(input.task);
				const output: SpawnAgentOutput = {
					text: result.text,
					iterations: result.iterations,
					finishReason: result.finishReason,
					usage: {
						inputTokens: result.usage.inputTokens,
						outputTokens: result.usage.outputTokens,
					},
				};
				if (config.onSubAgentEnd) {
					try {
						await config.onSubAgentEnd({
							subAgentId,
							conversationId,
							parentAgentId,
							input,
							result: output,
							agentResult: result,
						});
					} catch {
						// Best-effort observer callback.
					}
				}
				return output;
			} catch (error) {
				if (config.onSubAgentEnd) {
					try {
						await config.onSubAgentEnd({
							subAgentId,
							conversationId,
							parentAgentId,
							input,
							error: error instanceof Error ? error : new Error(String(error)),
						});
					} catch {
						// Best-effort observer callback.
					}
				}
				throw error;
			} finally {
				if (toolCallId) {
					config.abortHandleRegistry?.unregister(toolCallId);
				}
			}
		},
		timeoutMs: 300000,
		retryable: false,
	});
}
