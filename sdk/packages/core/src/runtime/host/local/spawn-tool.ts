import type {
	AgentEvent,
	AgentTool,
	ToolApprovalRequest,
	ToolApprovalResult,
} from "@cline/shared";
import { REASONING_LEVELS } from "@cline/shared";
import {
	createAskModeMcpGateExtension,
	MCP_TOOL_METADATA_KEY,
} from "../../../extensions/mcp";
import {
	createBuiltinTools,
	type ToolExecutors,
	ToolPresets,
} from "../../../extensions/tools";
import {
	createPlanModeCommandGuardExtension,
	PLAN_MODE_COMMAND_GUARD_EXTENSION_NAME,
} from "../../../extensions/tools/command-guard-extension";
import type {
	DelegatedAgentConnectionConfig,
	SpawnAgentInput,
	SubAgentEndContext,
	SubAgentStartContext,
} from "../../../extensions/tools/team";
import { createSpawnAgentTool } from "../../../extensions/tools/team";
import { buildTelemetryAgentIdentity } from "../../../services/agent-events";
import { filterDisabledTools } from "../../../services/global-settings";
import {
	captureAgentCreated,
	captureSubagentExecution,
} from "../../../services/telemetry/core-events";
import { makeSubSessionId } from "../../../session/models/session-graph";
import type { CoreSessionConfig } from "../../../types/config";
import type { CoreSessionEvent } from "../../../types/events";
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
	emit?: (event: CoreSessionEvent) => void;
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
	onSubAgentStart: (context: SubAgentStartContext) => void | Promise<void>;
	onSubAgentEnd: (context: SubAgentEndContext) => void | Promise<void>;
}

export function createSessionSubAgentLifecycleCallbacks(
	deps: SpawnToolDeps,
	config: CoreSessionConfig,
	rootSessionId: string,
): SessionSubAgentLifecycleCallbacks {
	return {
		onSubAgentEvent: (event) => deps.onAgentEvent(rootSessionId, config, event),
		onSubAgentStart: async (context) => {
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
			await deps.invokeBackendOptional("handleSubAgentStart", rootSessionId, {
				...context,
				input: {
					...context.input,
					access:
						context.input.access === "write" && config.mode !== "plan"
							? "write"
							: "read",
				},
			});
			deps.emit?.({
				type: "subagent",
				payload: {
					sessionId: rootSessionId,
					childSessionId: makeSubSessionId(rootSessionId, context.subAgentId),
					agentId: context.subAgentId,
					parentAgentId: context.parentAgentId,
					toolCallId: context.toolCallId,
					prompt: context.input.task,
					access:
						context.input.access === "write" && config.mode !== "plan"
							? "write"
							: "read",
					status: "running",
				},
			});
		},
		onSubAgentEnd: async (context) => {
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
			await deps.invokeBackendOptional("handleSubAgentEnd", rootSessionId, {
				...context,
				input: {
					...context.input,
					access:
						context.input.access === "write" && config.mode !== "plan"
							? "write"
							: "read",
				},
			});
			deps.emit?.({
				type: "subagent",
				payload: {
					sessionId: rootSessionId,
					childSessionId: makeSubSessionId(rootSessionId, context.subAgentId),
					agentId: context.subAgentId,
					parentAgentId: context.parentAgentId,
					toolCallId: context.toolCallId,
					prompt: context.input.task,
					access:
						context.input.access === "write" && config.mode !== "plan"
							? "write"
							: "read",
					status:
						context.error || context.result?.finishReason === "error"
							? "failed"
							: context.result?.finishReason === "aborted"
								? "cancelled"
								: "completed",
				},
			});
		},
	};
}

/** Reserved spawn_agent `profile` value: run the child on the parent's own model. */
export const INHERIT_SUBAGENT_PROFILE = "parent";

export interface SubagentProfileSelection {
	/** Connection overrides merged over the inherited config. Empty/absent means inherit. */
	overrides?: Partial<DelegatedAgentConnectionConfig>;
	/** The profile display name applied (for the UI chip); undefined means inherit. */
	profileName?: string;
	/** The immutable id of the applied profile; "parent" or undefined means inherit. */
	profileId?: string;
	/** The effort applied after input > profile > default resolution. */
	reasoningEffort?: string;
	/** Set when the requested profile/effort is not usable — return it as the tool error. */
	error?: string;
}

const REASONING_LEVEL_SET = new Set<string>(REASONING_LEVELS);

const displayProfileName = (
	settings: CoreSessionConfig["subagentSettings"],
	id: string,
): string => settings?.profileNames?.[id]?.trim() || id;

/** `Name (id)`, the form shown to the model so duplicate names stay distinguishable. */
const describeProfile = (
	settings: CoreSessionConfig["subagentSettings"],
	id: string,
): string =>
	id === INHERIT_SUBAGENT_PROFILE
		? `"${id}"`
		: `${displayProfileName(settings, id)} (${id})`;

type ProfileRefResolution = { id: string } | { error: string };

/**
 * Map a spawn_agent `profile` value to an allowed profile id. Ids are the
 * authority; a display name is accepted only when exactly one configured
 * profile carries it, so a duplicate name can never select (or borrow the
 * credentials of) a profile other than the one the user allowed.
 */
function resolveProfileRef(
	requested: string,
	settings: CoreSessionConfig["subagentSettings"],
): ProfileRefResolution {
	const allowed = settings?.allowedProfiles ?? [];
	const listAllowed = () =>
		allowed.map((id) => describeProfile(settings, id)).join(", ") || "(none)";
	const notAllowed = {
		error: `Sub-agent profile "${requested}" is not allowed. Allowed profiles: ${listAllowed()}.`,
	};
	if (allowed.includes(requested)) return { id: requested };
	const profiles = settings?.profiles ?? {};
	// An id that exists but is not allowed must not be reachable by any route.
	if (requested in profiles) return notAllowed;
	const named = Object.keys(profiles).filter(
		(id) => displayProfileName(settings, id) === requested,
	);
	if (named.length === 0) return notAllowed;
	const candidates = named.filter((id) => allowed.includes(id));
	if (candidates.length === 0) return notAllowed;
	if (named.length > 1) {
		return {
			error: `Sub-agent profile name "${requested}" is ambiguous. Pass the profile id: ${candidates.map((id) => describeProfile(settings, id)).join(", ")}.`,
		};
	}
	return { id: candidates[0] as string };
}

/**
 * Resolve a spawn_agent call's `profile`/`reasoningEffort` params against the
 * session's configured sub-agent profiles. Profiles only apply when the host
 * enabled them (a non-empty `profiles` map); any use while disabled, an
 * unlisted name, or an unknown effort value produces a descriptive error the
 * model can self-correct from.
 */
export function selectSubagentProfile(
	input: Pick<SpawnAgentInput, "profile" | "reasoningEffort">,
	settings: CoreSessionConfig["subagentSettings"],
): SubagentProfileSelection {
	const profiles = settings?.profiles;
	const enabled = !!profiles && Object.keys(profiles).length > 0;
	const requested = input.profile?.trim();
	if (!enabled) {
		if (requested || input.reasoningEffort !== undefined) {
			return {
				error:
					"Sub-agent model profiles are not enabled, so `profile` and `reasoningEffort` cannot be used. Omit them to inherit this thread's model.",
			};
		}
		return {};
	}
	const effort = input.reasoningEffort?.trim();
	if (effort !== undefined && !REASONING_LEVEL_SET.has(effort)) {
		return {
			error: `Invalid reasoningEffort "${input.reasoningEffort}". Allowed values: ${REASONING_LEVELS.join(", ")}.`,
		};
	}
	// "none" asks for no reasoning: strip any inherited effort rather than
	// forwarding a value ReasoningEffort excludes.
	const effortOverrides = (
		value: string | undefined,
	): Partial<DelegatedAgentConnectionConfig> =>
		value === undefined
			? {}
			: value === "none"
				? { thinking: false, reasoningEffort: undefined }
				: {
						reasoningEffort:
							value as DelegatedAgentConnectionConfig["reasoningEffort"],
					};
	// "none" only counts when the call asked for it — a stored profile/default
	// "none" is just the provider default and must not force thinking off.
	// Hosts may explicitly opt into provider defaults for effort-less profiles.
	// Other SDK consumers keep call > profile > settings fallback precedence.
	const resolveEffort = (connectionEffort?: string, profile = false) => {
		const resolved =
			effort ??
			connectionEffort ??
			(profile && settings?.profilesUseProviderDefaultEffort
				? undefined
				: settings?.defaultReasoningEffort);
		return resolved === "none" && effort !== "none" ? undefined : resolved;
	};
	if (requested) {
		const resolution = resolveProfileRef(requested, settings);
		if ("error" in resolution) return { error: resolution.error };
		const id = resolution.id;
		if (id === INHERIT_SUBAGENT_PROFILE) {
			const resolvedEffort = resolveEffort();
			return {
				profileName: id,
				profileId: id,
				reasoningEffort: resolvedEffort,
				overrides: effortOverrides(resolvedEffort),
			};
		}
		const connection = profiles?.[id];
		if (!connection) {
			return {
				error: `Sub-agent profile "${describeProfile(settings, id)}" is allowed but not configured.`,
			};
		}
		const resolvedEffort = resolveEffort(connection.reasoningEffort, true);
		return {
			profileName: displayProfileName(settings, id),
			profileId: id,
			reasoningEffort: resolvedEffort,
			overrides: { ...connection, ...effortOverrides(resolvedEffort) },
		};
	}
	// No profile requested: the configured default applies when it resolves,
	// otherwise the child inherits the parent's connection.
	const defaultId = settings?.defaultProfile;
	const connection = defaultId ? profiles?.[defaultId] : undefined;
	const resolvedEffort = resolveEffort(
		connection?.reasoningEffort,
		!!connection,
	);
	return {
		profileName:
			connection && defaultId
				? displayProfileName(settings, defaultId)
				: undefined,
		profileId: connection ? defaultId : undefined,
		reasoningEffort: resolvedEffort,
		overrides: {
			...(connection ?? {}),
			...effortOverrides(resolvedEffort),
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
		for (const tool of available) {
			const hostAccess = tool.metadata?.subagentAccess;
			if (
				config.enableTools &&
				(hostAccess === "read" ||
					(hostAccess === "write" && access === "write"))
			) {
				allowedNames.add(tool.name);
			}
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

	// Profile params only exist for the model when the host enabled sub-agent
	// profiles; stripping them from the schema keeps disabled sessions honest.
	const profilesEnabled =
		!!settings.profiles && Object.keys(settings.profiles).length > 0;
	const allowedProfileIds = settings.allowedProfiles ?? [];
	const allowedProfileList =
		allowedProfileIds.map((id) => describeProfile(settings, id)).join(", ") ||
		"(none)";

	const spawnTool = createSpawnAgentTool({
		resolveConnectionOverrides: (input) =>
			selectSubagentProfile(input, settings).overrides,
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
		onSubAgentMessages: (agentId, messages) =>
			deps.invokeBackendOptional(
				"persistSessionMessages",
				makeSubSessionId(rootSessionId, agentId),
				messages,
			),
		...lifecycle,
	}) as AgentTool;
	const inputSchema = structuredClone(spawnTool.inputSchema) as {
		properties?: Record<string, Record<string, unknown>>;
	};
	const profileSchema = inputSchema.properties?.profile;
	let description = spawnTool.description;
	if (profilesEnabled) {
		if (profileSchema) {
			profileSchema.enum = allowedProfileIds;
			profileSchema.description = `Sub-agent model profile id to run on. Allowed profiles (name (id)): ${allowedProfileList}. Pass the id; a name is accepted only when it is unique. Omit to use the configured default, or "parent" to inherit your model.`;
		}
		description = `${spawnTool.description} Sub-agent model profiles are enabled: you may pass profile (an id from: ${allowedProfileList}) and reasoningEffort (${REASONING_LEVELS.join(", ")}) to control the sub-agent's model.${settings.defaultProfile ? ` Omitting profile uses the default ${describeProfile(settings, settings.defaultProfile)}.` : ""}`;
	} else {
		if (inputSchema.properties) {
			delete inputSchema.properties.profile;
			delete inputSchema.properties.reasoningEffort;
		}
	}
	return {
		...spawnTool,
		description,
		inputSchema,
		execute: async (rawInput, context) => {
			const input = rawInput as SpawnAgentInput;
			if (input.access === "write" && settings.allowWrite === false) {
				return {
					error:
						"Write subagents are disabled in Subagents settings. Use access=read.",
				};
			}
			const selection = selectSubagentProfile(input, settings);
			if (selection.error) {
				return { error: selection.error };
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
				// Surface the resolved model on the subagent row; the translator
				// attaches these fields to the matching spawn_agent entry.
				if (selection.profileName || selection.reasoningEffort) {
					context.emitUpdate?.({
						profile: selection.profileName,
						reasoningEffort: selection.reasoningEffort,
					});
				}
				return await spawnTool.execute(input, context);
			} finally {
				const remaining = (activeCounts.get(rootSessionId) ?? 1) - 1;
				if (remaining > 0) activeCounts.set(rootSessionId, remaining);
				else activeCounts.delete(rootSessionId);
			}
		},
	};
}
