// Bridges Cline's file-based hook scripts into the SDK's runtime hooks.
//
// Runtime hooks use typed in-process lifecycle callbacks:
//   TaskStart        -> beforeRun, only on the task's first-ever run (no
//                       assistant history), once per task across rebuilds
//   TaskResume       -> beforeRun of a session built by reopening a task
//                       (options.taskResumed), once per resume
//   UserPromptSubmit -> beforeRun, only when the run's tail message is a real
//                       user prompt — never for tool-result continuations,
//                       mode-switch auto-continues, synthetic resumption
//                       prompts, or rebuild replays of an unanswered prompt
//   PreToolUse       -> beforeTool
//   PostToolUse      -> afterTool
//   TaskComplete     -> afterRun when completed
//   TaskCancel       -> afterRun when aborted
//
// Status rows are emitted only for noteworthy outcomes: a hook that runs and
// exits quietly (no cancel, error message, or context modification) leaves no
// hook_status row.
//
// Deferred hooks (NOT wired here): TaskError, SessionShutdown,
// PreCompact, Notification.

import type {
	AgentAfterToolContext,
	AgentBeforeToolContext,
	AgentHooks,
	AgentRunLifecycleContext,
	AgentRunStartResult,
	AgentStopControl,
} from "@cline/shared"
import type { ClineMessage } from "@shared/ExtensionMessage"
import { Logger } from "@shared/services/Logger"
import { HookFactory } from "@/core/hooks/hook-factory"
import { getHooksEnabledSafe } from "@/core/hooks/hooks-utils"
import type { StateManager } from "@/core/storage/StateManager"
import { isSyntheticUserPrompt } from "./sdk-user-message-mapping"

export type HookMessageEmitter = (message: ClineMessage) => void

export interface BuildAgentHooksOptions {
	/**
	 * True when this session was started by resuming an existing task from
	 * history (not a session rebuild). The first run of the session then fires
	 * TaskResume instead of TaskStart.
	 */
	taskResumed?: boolean
}

// Process-wide per-task bookkeeping. Hook closures are rebuilt for every
// session replacement (mode switch, MCP tool refresh, provider change), so
// "once per task" state must live outside the closure to survive rebuilds.
const taskStartFiredForTask = new Set<string>()
// Indexes of the transcript tail user prompt that already got a
// UserPromptSubmit dispatch, keyed by task id. A rebuild can re-run a turn
// whose unanswered prompt is still the transcript tail; the index is stable
// across rebuilds because the persisted transcript is replayed verbatim.
const promptSubmitFiredIndexes = new Map<string, Set<number>>()

/** Test-only: clears the process-wide once-per-task hook state. */
export function resetHookFiringStateForTests(): void {
	taskStartFiredForTask.clear()
	promptSubmitFiredIndexes.clear()
}

function toStringRecord(input: unknown): Record<string, string> {
	if (input == null || typeof input !== "object" || Array.isArray(input)) {
		return {}
	}
	const result: Record<string, string> = {}
	for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
		result[key] = typeof value === "string" ? value : JSON.stringify(value)
	}
	return result
}

function mapStopControl(hookOutput: {
	cancel?: boolean
	errorMessage?: string
	contextModification?: string
}): AgentStopControl | undefined {
	if (!hookOutput.cancel) {
		return undefined
	}
	// A cancelling hook's contextModification is never injected as context;
	// it serves as the fallback explanation when no errorMessage was given.
	const reason = hookOutput.errorMessage?.trim() || hookOutput.contextModification?.trim() || undefined
	return {
		stop: true,
		reason,
	}
}

/**
 * Maps a hook's output to a stop-or-context result: cancel stops the run (its
 * message travels as the reason, never as context), otherwise
 * contextModification is returned for injection as a <hook_context> block.
 * HookFactory already truncates contextModification at 50KB.
 */
function mapStopOrContextResult(hookOutput: {
	cancel?: boolean
	errorMessage?: string
	contextModification?: string
}): AgentRunStartResult | undefined {
	const stopControl = mapStopControl(hookOutput)
	if (stopControl) {
		return stopControl
	}
	const contextModification = hookOutput.contextModification?.trim()
	return contextModification ? { appendContext: contextModification } : undefined
}

function taskIdFromSnapshot(snapshot: AgentRunLifecycleContext["snapshot"]): string {
	return snapshot.conversationId ?? snapshot.runId ?? snapshot.agentId
}

function textFromMessageContent(content: readonly { type: string; text?: string }[]): string {
	return content
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("")
}

function latestUserPrompt(ctx: AgentRunLifecycleContext): string {
	for (let index = ctx.snapshot.messages.length - 1; index >= 0; index -= 1) {
		const message = ctx.snapshot.messages[index]
		// Injected hook-context blocks are user-role messages with a system
		// display role; feeding one back to a hook as "the prompt" would hand
		// hooks their own previous output.
		if (message?.role === "user" && message.metadata?.displayRole !== "system") {
			return textFromMessageContent(message.content)
		}
	}
	return ""
}

/**
 * The run carries a fresh user prompt when the transcript tail is a real
 * user message. The session orchestrator appends the submitted user message
 * before the runtime starts, so the tail message at beforeRun is the run's
 * own prompt. Internal continuation runs — tool-result continuations,
 * auto-continue after a mode switch, queued non-user items, rebuild reruns —
 * end in an assistant/tool/synthetic message instead.
 */
function tailUserPrompt(ctx: AgentRunLifecycleContext): { index: number; prompt: string } | undefined {
	const index = ctx.snapshot.messages.length - 1
	const message = ctx.snapshot.messages[index]
	if (message?.role !== "user" || message.metadata?.displayRole === "system") {
		return undefined
	}
	// Tool results and provider-executed tool output are user-role messages
	// but not user input.
	if (message.content.some((part) => part.type === "tool-result")) {
		return undefined
	}
	const prompt = textFromMessageContent(message.content)
	if (isSyntheticUserPrompt(prompt)) {
		return undefined
	}
	return { index, prompt }
}

/**
 * Quiet hooks — a script ran, succeeded, and produced no cancellation,
 * error, or context — emit no status row. Only noteworthy outcomes
 * (cancelled, failed, context-injecting completions) stay visible.
 */
function hookResultIsQuiet(result: { cancel?: boolean; errorMessage?: string; contextModification?: string }): boolean {
	return !result.cancel && !result.errorMessage?.trim() && !result.contextModification?.trim()
}

function buildHookStatusMessage(opts: {
	hookName: string
	status: "running" | "completed" | "failed" | "cancelled"
	toolName?: string
	ts?: number
}): ClineMessage {
	return {
		ts: opts.ts ?? Date.now(),
		type: "say",
		say: "hook_status",
		text: JSON.stringify({
			hookName: opts.hookName,
			...(opts.toolName && { toolName: opts.toolName }),
			status: opts.status,
		}),
		partial: false,
	}
}

export function buildAgentHooks(
	stateManager: StateManager,
	emitHookMessage?: HookMessageEmitter,
	sessionWorkspaceRoot?: string,
	options?: BuildAgentHooksOptions,
): AgentHooks {
	const hooksEnabled = () => getHooksEnabledSafe(stateManager.getGlobalSettingsKey("hooksEnabled"))
	// Session-scoped discovery: the session's root is not always among the
	// window's workspace folders (e.g. the chat-workspace fallback when no
	// folder is open), so the factory also scans this session's own workspace.
	const createFactory = () => new HookFactory({ sessionWorkspaceRoot })
	// TaskResume fires on the first run of a session built by reopening a task
	// from history. Session rebuilds never carry this flag, so it cannot fire
	// on a mode-switch/MCP/provider rebuild.
	let taskResumePending = options?.taskResumed === true

	return {
		async beforeRun(ctx: AgentRunLifecycleContext): Promise<AgentRunStartResult | undefined> {
			const taskId = taskIdFromSnapshot(ctx.snapshot)
			// A transcript with no assistant reply has never completed a turn:
			// this run is the task's first. Reopened chats, mid-task rebuilds and
			// later turns all carry assistant history, so TaskStart cannot
			// re-fire for them.
			const isFirstRunOfTask = !ctx.snapshot.messages.some((message) => message.role === "assistant")
			const results: (AgentRunStartResult | undefined)[] = []

			if (isFirstRunOfTask && !taskStartFiredForTask.has(taskId)) {
				taskStartFiredForTask.add(taskId)
				const taskStart = await runTaskStart(ctx, hooksEnabled, createFactory, emitHookMessage)
				if (taskStart?.stop) {
					return taskStart
				}
				results.push(taskStart)
			}

			if (taskResumePending) {
				taskResumePending = false
				// A resumed task that never produced a reply gets TaskStart above;
				// TaskResume is only for tasks returning with real history.
				if (!isFirstRunOfTask) {
					const taskResume = await runTaskResume(ctx, hooksEnabled, createFactory, emitHookMessage)
					if (taskResume?.stop) {
						return taskResume
					}
					results.push(taskResume)
				}
			}

			const promptRun = tailUserPrompt(ctx)
			if (promptRun) {
				const fired = promptSubmitFiredIndexes.get(taskId) ?? new Set<number>()
				if (!fired.has(promptRun.index)) {
					fired.add(promptRun.index)
					promptSubmitFiredIndexes.set(taskId, fired)
					const promptSubmit = await runUserPromptSubmit(ctx, hooksEnabled, createFactory, emitHookMessage)
					if (promptSubmit?.stop) {
						return promptSubmit
					}
					results.push(promptSubmit)
				}
			}

			const appendContext = results
				.map((result) => result?.appendContext)
				.filter((text): text is string => Boolean(text?.trim()))
				.join("\n\n")
			return appendContext ? { appendContext } : undefined
		},

		async beforeTool(
			ctx: AgentBeforeToolContext,
		): Promise<{ stop?: boolean; reason?: string; appendContext?: string } | undefined> {
			try {
				if (!hooksEnabled()) {
					return undefined
				}

				const taskId = taskIdFromSnapshot(ctx.snapshot)
				const toolName = ctx.toolCall.toolName
				const factory = createFactory()
				const runner = await factory.create("PreToolUse", taskId, toolName)
				if (runner.isNoOp) {
					return undefined
				}

				const result = await runner.run({
					taskId,
					preToolUse: {
						toolName,
						parameters: toStringRecord(ctx.input),
					},
				})

				if (!hookResultIsQuiet(result)) {
					emitHookMessage?.(
						buildHookStatusMessage({
							hookName: "PreToolUse",
							toolName,
							status: result.cancel ? "cancelled" : "completed",
						}),
					)
				}
				return mapStopOrContextResult(result)
			} catch (error) {
				emitHookMessage?.(
					buildHookStatusMessage({
						hookName: "PreToolUse",
						toolName: ctx.toolCall.toolName,
						status: "failed",
					}),
				)
				Logger.error("[HooksAdapter] beforeTool hook failed:", error)
				return undefined
			}
		},

		async afterTool(
			ctx: AgentAfterToolContext,
		): Promise<{ stop?: boolean; reason?: string; appendContext?: string } | undefined> {
			try {
				if (!hooksEnabled()) {
					return undefined
				}

				const taskId = taskIdFromSnapshot(ctx.snapshot)
				const toolName = ctx.toolCall.toolName
				const factory = createFactory()
				const runner = await factory.create("PostToolUse", taskId, toolName)
				if (runner.isNoOp) {
					return undefined
				}

				const result = await runner.run({
					taskId,
					postToolUse: {
						toolName,
						parameters: toStringRecord(ctx.input),
						result: String(ctx.result.output ?? ""),
						success: !ctx.result.isError,
						executionTimeMs: ctx.durationMs,
					},
				})

				if (!hookResultIsQuiet(result)) {
					emitHookMessage?.(
						buildHookStatusMessage({
							hookName: "PostToolUse",
							toolName,
							status: result.cancel ? "cancelled" : "completed",
						}),
					)
				}
				return mapStopOrContextResult(result)
			} catch (error) {
				emitHookMessage?.(
					buildHookStatusMessage({
						hookName: "PostToolUse",
						toolName: ctx.toolCall.toolName,
						status: "failed",
					}),
				)
				Logger.error("[HooksAdapter] afterTool hook failed:", error)
				return undefined
			}
		},

		async afterRun(ctx): Promise<void> {
			let hookName: "TaskComplete" | "TaskCancel" | undefined
			try {
				if (!hooksEnabled()) {
					return
				}

				hookName =
					ctx.result.status === "completed"
						? "TaskComplete"
						: ctx.result.status === "aborted"
							? "TaskCancel"
							: undefined
				if (!hookName) {
					return
				}

				const taskId = taskIdFromSnapshot(ctx.snapshot)
				const factory = createFactory()
				const runner = await factory.create(hookName, taskId)
				if (runner.isNoOp) {
					return
				}

				const result =
					hookName === "TaskComplete"
						? await runner.run({
								taskId,
								taskComplete: {
									taskMetadata: {
										taskId,
										ulid: "",
										initialTask: "",
										result: ctx.result.outputText,
									},
								},
							})
						: await runner.run({
								taskId,
								taskCancel: {
									taskMetadata: {
										taskId,
										ulid: "",
										initialTask: "",
										completionStatus: "cancelled",
									},
								},
							})

				if (!hookResultIsQuiet(result)) {
					emitHookMessage?.(buildHookStatusMessage({ hookName, status: result.cancel ? "cancelled" : "completed" }))
				}
			} catch (error) {
				emitHookMessage?.(buildHookStatusMessage({ hookName: hookName ?? "TaskComplete", status: "failed" }))
				Logger.error("[HooksAdapter] afterRun hook failed:", error)
			}
		},
	}
}

async function runTaskStart(
	ctx: AgentRunLifecycleContext,
	hooksEnabled: () => boolean,
	createFactory: () => HookFactory,
	emitHookMessage?: HookMessageEmitter,
): Promise<AgentRunStartResult | undefined> {
	try {
		if (!hooksEnabled()) {
			return undefined
		}

		const taskId = taskIdFromSnapshot(ctx.snapshot)
		const factory = createFactory()
		const runner = await factory.create("TaskStart", taskId)
		if (runner.isNoOp) {
			return undefined
		}

		const result = await runner.run({
			taskId,
			taskStart: {
				taskMetadata: {
					taskId,
					ulid: "",
					initialTask: latestUserPrompt(ctx),
				},
			},
		})

		if (!hookResultIsQuiet(result)) {
			emitHookMessage?.(
				buildHookStatusMessage({
					hookName: "TaskStart",
					status: result.cancel ? "cancelled" : "completed",
				}),
			)
		}
		return mapStopOrContextResult(result)
	} catch (error) {
		emitHookMessage?.(buildHookStatusMessage({ hookName: "TaskStart", status: "failed" }))
		Logger.error("[HooksAdapter] beforeRun (TaskStart) hook failed:", error)
		return undefined
	}
}

async function runTaskResume(
	ctx: AgentRunLifecycleContext,
	hooksEnabled: () => boolean,
	createFactory: () => HookFactory,
	emitHookMessage?: HookMessageEmitter,
): Promise<AgentRunStartResult | undefined> {
	try {
		if (!hooksEnabled()) {
			return undefined
		}

		const taskId = taskIdFromSnapshot(ctx.snapshot)
		const factory = createFactory()
		const runner = await factory.create("TaskResume", taskId)
		if (runner.isNoOp) {
			return undefined
		}

		const result = await runner.run({
			taskId,
			taskResume: {
				taskMetadata: {
					taskId,
					ulid: "",
					initialTask: latestUserPrompt(ctx),
				},
				previousState: {},
			},
		})

		if (!hookResultIsQuiet(result)) {
			emitHookMessage?.(
				buildHookStatusMessage({
					hookName: "TaskResume",
					status: result.cancel ? "cancelled" : "completed",
				}),
			)
		}
		return mapStopOrContextResult(result)
	} catch (error) {
		emitHookMessage?.(buildHookStatusMessage({ hookName: "TaskResume", status: "failed" }))
		Logger.error("[HooksAdapter] beforeRun (TaskResume) hook failed:", error)
		return undefined
	}
}

async function runUserPromptSubmit(
	ctx: AgentRunLifecycleContext,
	hooksEnabled: () => boolean,
	createFactory: () => HookFactory,
	emitHookMessage?: HookMessageEmitter,
): Promise<AgentRunStartResult | undefined> {
	try {
		if (!hooksEnabled()) {
			return undefined
		}

		const taskId = taskIdFromSnapshot(ctx.snapshot)
		const factory = createFactory()
		const runner = await factory.create("UserPromptSubmit", taskId)
		if (runner.isNoOp) {
			return undefined
		}

		const result = await runner.run({
			taskId,
			userPromptSubmit: {
				prompt: latestUserPrompt(ctx),
				attachments: [],
			},
		})

		if (!hookResultIsQuiet(result)) {
			emitHookMessage?.(
				buildHookStatusMessage({
					hookName: "UserPromptSubmit",
					status: result.cancel ? "cancelled" : "completed",
				}),
			)
		}
		return mapStopOrContextResult(result)
	} catch (error) {
		emitHookMessage?.(buildHookStatusMessage({ hookName: "UserPromptSubmit", status: "failed" }))
		Logger.error("[HooksAdapter] beforeRun (UserPromptSubmit) hook failed:", error)
		return undefined
	}
}
