import type {
	AgentEvent,
	AgentTool,
	ToolApprovalRequest,
	ToolApprovalResult,
} from "@cline/shared";
import {
	createBuiltinTools,
	type ToolExecutors,
	ToolPresets,
} from "../../../extensions/tools";
import type {
	SpawnAgentInput,
	SubAgentEndContext,
	SubAgentStartContext,
} from "../../../extensions/tools/team";
import { createSpawnAgentTool } from "../../../extensions/tools/team";
import {
	createPlanModeCommandGuardExtension,
	PLAN_MODE_COMMAND_GUARD_EXTENSION_NAME,
} from "../../../extensions/tools/command-guard-extension";
import {
	createAskModeMcpGateExtension,
	MCP_TOOL_METADATA_KEY,
} from "../../../extensions/mcp";
import { buildTelemetryAgentIdentity } from "../../../services/agent-events";
import { filterDisabledTools } from "../../../services/global-settings";
import {
	captureAgentCreated,
	captureSubagentExecution,
} from "../../../services/telemetry/core-events";
import type { CoreSessionConfig } from "../../../types/config";
import type { ActiveSession } from "../../../types/session";
import { filterToolsByPolicies } from "../../orchestration/runtime-builder";

export type SubAgentStartTracker = Map<
	string,
	{ startedAt: number; rootSessionId: string }
>;

/**
 * Per-call abort handles for in-flight sub-agent runs, scoped by root
 * session id + spawn_agent tool call id. Lets a host stop one child agent
 * without aborting the parent run.
 */
export interface SubAgentAbortTracker {
	register(
		rootSessionId: string,
		toolCallId: string,
		controller: AbortController,
	): void;
	unregister(rootSessionId: string, toolCallId: string): void;
}

const activeSubagentCounts = new WeakMap<
	SubAgentStartTracker,
	Map<string, number>
>();

export interface SpawnToolDeps {
	requestToolApproval?: (
		request: ToolApprovalRequest,
	) => Promise<ToolApprovalResult> | ToolApprovalResult;
	getSession(sessionId: string): ActiveSession | undefined;
	subAgentStarts: SubAgentStartTracker;
	subAgentAborts?: SubAgentAbortTracker;
	onAgentEvent(
		rootSessionId: string,
		config: CoreSessionConfig,
		event: AgentEvent,
	): void;
	invokeBackendOptional(method: string, ...args: unknown[]): Promise<void>;
}

export interface SessionSubAgentLifecycleCallbacks {
	onSubAgentEvent: (event: AgentEvent) => void;
	onSubAgentStart: (context: SubAgentStartContext) => void;
	onSubAgentEnd: (context: SubAgentEndContext) => void;
}

export function createSessionSubAgentLifecycleCallbacks(
	deps: SpawnToolDeps,
	config: CoreSessionConfig,
	rootSessionId: string,
): SessionSubAgentLifecycleCallbacks {
	return {
		onSubAgentEvent: (event) => deps.onAgentEvent(rootSessionId, config, event),
		onSubAgentStart: (context) => {
			const teamRuntime = deps.getSession(rootSessionId)?.runtime.teamRuntime;
			deps.subAgentStarts.set(context.subAgentId, {
				startedAt: Date.now(),
				rootSessionId,
			});
			const agentIdentity = buildTelemetryAgentIdentity({
				agentId: context.subAgentId,
				conversationId: context.conversationId,
				parentAgentId: context.parentAgentId,
				teamId: teamRuntime?.getTeamId(),
				teamName: teamRuntime?.getTeamName(),
				createdByAgentId: context.parentAgentId,
			});
			if (agentIdentity) {
				captureAgentCreated(config.telemetry, {
					ulid: rootSessionId,
					modelId: config.modelId,
					provider: config.providerId,
					...agentIdentity,
				});
			}
			captureSubagentExecution(config.telemetry, {
				event: "started",
				ulid: rootSessionId,
				durationMs: 0,
				parentId: context.parentAgentId,
				agentId: context.subAgentId,
				...agentIdentity,
			});
			void deps.invokeBackendOptional(
				"handleSubAgentStart",
				rootSessionId,
				context,
			);
		},
		onSubAgentEnd: (context) => {
			const teamRuntime = deps.getSession(rootSessionId)?.runtime.teamRuntime;
			const started = deps.subAgentStarts.get(context.subAgentId);
			const durationMs = started ? Date.now() - started.startedAt : 0;
			const outputLines = context.result?.text
				? context.result.text.split("\n").length
				: 0;
			captureSubagentExecution(config.telemetry, {
				event: "ended",
				ulid: rootSessionId,
				durationMs,
				outputLines,
				errorMessage: context.error ? String(context.error) : undefined,
				agentId: context.subAgentId,
				parentId: context.parentAgentId,
				...buildTelemetryAgentIdentity({
					agentId: context.subAgentId,
					conversationId: context.conversationId,
					parentAgentId: context.parentAgentId,
					teamId: teamRuntime?.getTeamId(),
					teamName: teamRuntime?.getTeamName(),
					createdByAgentId: context.parentAgentId,
				}),
			});
			deps.subAgentStarts.delete(context.subAgentId);
			void deps.invokeBackendOptional(
				"handleSubAgentEnd",
				rootSessionId,
				context,
			);
		},
	};
}

export function createSessionSpawnTool(
	deps: SpawnToolDeps,
	config: CoreSessionConfig,
	rootSessionId: string,
	toolExecutors?: Partial<ToolExecutors>,
): AgentTool {
	const lifecycle = createSessionSubAgentLifecycleCallbacks(
		deps,
		config,
		rootSessionId,
	);
	const settings = config.subagentSettings ?? {};
	let counts = activeSubagentCounts.get(deps.subAgentStarts);
	if (!counts) {
		counts = new Map();
		activeSubagentCounts.set(deps.subAgentStarts, counts);
	}
	const activeCounts = counts;
	const effectiveAccess = (input: SpawnAgentInput) =>
		input.access === "write" && config.mode !== "plan" ? "write" : "read";
	const createSubAgentTools = (input: SpawnAgentInput) => {
		// Writer subagents get the act preset; readers get the plan (read-only)
		// preset. A parent in plan mode can never spawn a writer -- the request
		// is downgraded to read. The resulting toolset is intersected with the
		// parent's tool policies and global disables so a child can never
		// exceed the parent's effective tools.
		const access = effectiveAccess(input);
		const preset = access === "write" ? ToolPresets.act : ToolPresets.plan;
		const tools: AgentTool[] = config.enableTools
			? createBuiltinTools({
					cwd: config.cwd,
					telemetry: config.telemetry,
					...preset,
					executors: toolExecutors,
				})
			: [];
		if (config.enableSpawnAgent) {
			tools.push(
				createSessionSpawnTool(
					deps,
					{ ...config, mode: access === "read" ? "plan" : "act" },
					rootSessionId,
					toolExecutors,
				),
			);
		}
		// Use the parent's actual tools, including host replacements and MCP,
		// rather than recreating tools the parent does not have.
		const parentTools = deps.getSession(rootSessionId)?.runtime.tools;
		const available = parentTools
			? [...parentTools, ...(config.extraTools ?? [])]
			: [...tools, ...(config.extraTools ?? [])];
		const allowedNames = new Set(tools.map((tool) => tool.name));
		if (config.enableTools && preset.enableBash)
			allowedNames.add("run_commands");
		if (config.enableTools && access === "write") {
			allowedNames.add("editor");
			allowedNames.add("apply_patch");
		}
		const childTools = available
			.filter((tool) => {
				const isMcp = !!tool.metadata?.[MCP_TOOL_METADATA_KEY];
				if (isMcp) return config.enableTools && settings.allowMcp !== false;
				if (!allowedNames.has(tool.name)) return false;
				if (tool.name === "run_commands" && settings.allowCommands === false)
					return false;
				if (
					[
						"fetch_web_content",
						"web_fetch",
						"web_search",
						"browser_action",
					].includes(tool.name) &&
					settings.allowWeb === false
				)
					return false;
				return true;
			})
			.map((tool) =>
				tool.name === "spawn_agent"
					? tools.find((child) => child.name === "spawn_agent")!
					: tool,
			);
		return filterToolsByPolicies(
			filterDisabledTools([
				...new Map(childTools.map((tool) => [tool.name, tool])).values(),
			]),
			config.toolPolicies,
		);
	};

	const spawnTool = createSpawnAgentTool({
		configProvider: {
			getRuntimeConfig: () =>
				deps
					.getSession(rootSessionId)
					?.runtime.delegatedAgentConfigProvider?.getRuntimeConfig() ?? {
					providerId: config.providerId,
					modelId: config.modelId,
					cwd: config.cwd,
					apiKey: config.apiKey,
					baseUrl: config.baseUrl,
					headers: config.headers,
					providerConfig: config.providerConfig,
					knownModels: config.knownModels,
					thinking: config.thinking,
					maxIterations: config.maxIterations,
					hooks: config.hooks,
					extensions: config.extensions,
					logger: config.logger,
					telemetry: config.telemetry,
				},
			getConnectionConfig: () =>
				deps
					.getSession(rootSessionId)
					?.runtime.delegatedAgentConfigProvider?.getConnectionConfig() ?? {
					providerId: config.providerId,
					modelId: config.modelId,
					apiKey: config.apiKey,
					baseUrl: config.baseUrl,
					headers: config.headers,
					providerConfig: config.providerConfig,
					knownModels: config.knownModels,
					thinking: config.thinking,
				},
			updateConnectionDefaults: () => {},
		},
		toolPolicies: config.toolPolicies,
		requestToolApproval: deps.requestToolApproval
			? (request) =>
					deps.requestToolApproval!({ ...request, sessionId: rootSessionId })
			: undefined,
		createSubAgentExtensions: (input) => {
			const extensions =
				deps.getSession(rootSessionId)?.runtime.extensions ??
				deps
					.getSession(rootSessionId)
					?.runtime.delegatedAgentConfigProvider?.getRuntimeConfig()
					.extensions ??
				config.extensions ??
				[];
			if (
				effectiveAccess(input) === "write" ||
				extensions.some(
					(extension) =>
						extension.name === PLAN_MODE_COMMAND_GUARD_EXTENSION_NAME,
				)
			)
				return extensions;
			return [
				...extensions,
				createPlanModeCommandGuardExtension({ telemetry: config.telemetry }),
				createAskModeMcpGateExtension(),
			];
		},
		createSubAgentTools,
		abortHandleRegistry: deps.subAgentAborts
			? {
					register: (toolCallId, controller) =>
						deps.subAgentAborts?.register(
							rootSessionId,
							toolCallId,
							controller,
						),
					unregister: (toolCallId) =>
						deps.subAgentAborts?.unregister(rootSessionId, toolCallId),
				}
			: undefined,
		...lifecycle,
	}) as AgentTool;
	return {
		...spawnTool,
		execute: async (rawInput, context) => {
			const input = rawInput as SpawnAgentInput;
			if (input.access === "write" && settings.allowWrite === false) {
				return {
					error:
						"Write subagents are disabled in Subagents settings. Use access=read.",
				};
			}
			const active = activeCounts.get(rootSessionId) ?? 0;
			const limit = settings.maxConcurrent ?? 0;
			if (limit > 0 && active >= limit) {
				return {
					error: `Maximum concurrent subagents (${limit}) reached. Wait for an active subagent to finish before spawning another.`,
				};
			}
			// Reserve before any await, so parallel calls cannot race the limit.
			activeCounts.set(rootSessionId, active + 1);
			try {
				return await spawnTool.execute(input, context);
			} finally {
				const remaining = (activeCounts.get(rootSessionId) ?? 1) - 1;
				if (remaining > 0) activeCounts.set(rootSessionId, remaining);
				else activeCounts.delete(rootSessionId);
			}
		},
	};
}
