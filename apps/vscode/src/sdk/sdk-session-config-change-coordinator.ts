import type { ClineMessage } from "@shared/ExtensionMessage"
import type { Mode } from "@shared/storage/types"
import type { StateManager } from "@/core/storage/StateManager"
import { Logger } from "@/shared/services/Logger"
import type { SdkMessageCoordinator } from "./sdk-message-coordinator"
import type { SdkSessionConfigBuilder } from "./sdk-session-config-builder"
import type { SdkSessionLifecycle } from "./sdk-session-lifecycle"
import type { SdkSessionRebuildScheduler, SessionRebuildContext, SessionRebuildReason } from "./sdk-session-rebuild-scheduler"
import type { SdkSessionHost } from "./session-host"
import type { VscodeSessionHost } from "./vscode-session-host"
import { getEffectiveTerminalExecutionMode, type VscodeTerminalExecutionMode } from "./vscode-terminal-execution-mode"

type StartInput = Parameters<VscodeSessionHost["start"]>[0]
type InitialMessages = StartInput["initialMessages"]
type SessionConfig = Awaited<ReturnType<SdkSessionConfigBuilder["build"]>>

export interface SdkSessionConfigChangeCoordinatorOptions {
	getMessages?: (sessionId: string) => SdkMessageCoordinator
	stateManager: StateManager
	sessions: SdkSessionLifecycle
	messages: SdkMessageCoordinator
	sessionConfigBuilder: SdkSessionConfigBuilder
	getWorkspaceRoot: () => Promise<string>
	loadInitialMessages: (sdkHost: SdkSessionHost, sessionId: string) => Promise<unknown[] | undefined>
	buildStartSessionInput: (config: SessionConfig, input: { cwd: string; mode: Mode }) => StartInput
	postStateToWebview: () => Promise<void>
	rebuilds: Pick<SdkSessionRebuildScheduler, "request">
}

interface RebuildDetails {
	reason: SessionRebuildReason
	description: string
	disposeReason: string
	failureMessage: string
}

export class SdkSessionConfigChangeCoordinator {
	constructor(private readonly options: SdkSessionConfigChangeCoordinatorOptions) {}

	handleTaskGroupChanged(threadId: string): void {
		this.requestRebuild(
			{
				reason: "taskGroup",
				description: "task notebook membership",
				disposeReason: "taskGroupChange",
				failureMessage: "Failed to reload the task notebook. Reopen the thread to retry.",
			},
			threadId,
		)
	}

	handleTerminalExecutionModeChanged(previous: VscodeTerminalExecutionMode, next: VscodeTerminalExecutionMode): void {
		if (previous === next) {
			return
		}
		this.requestRebuild({
			reason: "terminalExecutionMode",
			description: `terminal execution mode ${previous} -> ${next}`,
			disposeReason: "terminalExecutionModeChange",
			failureMessage: "Failed to reload terminal tools. Terminal mode changes may not apply until the next task.",
		})
	}

	handleSubagentSettingsChanged(): void {
		this.requestRebuild({
			reason: "subagents",
			description: "subagent settings",
			disposeReason: "subagentSettingsChange",
			failureMessage: "Failed to reload subagent settings. The change may not apply until the next task.",
		})
	}

	handleCheckpointsSettingChanged(previous: boolean, next: boolean): void {
		if (previous === next) {
			return
		}
		this.requestRebuild({
			reason: "checkpoints",
			description: `checkpoints ${previous ? "enabled" : "disabled"} -> ${next ? "enabled" : "disabled"}`,
			disposeReason: "checkpointsSettingChange",
			failureMessage: "Failed to reload checkpoint settings. The change may not apply until the next task.",
		})
	}

	private requestRebuild(details: RebuildDetails, sessionId?: string): void {
		Logger.log(`[SdkController] Session configuration changed: ${details.description}`)

		const activeSession = sessionId ? this.options.sessions.getSession(sessionId) : this.options.sessions.getActiveSession()
		if (!activeSession) {
			Logger.log("[SdkController] No active session - configuration will be picked up on next initTask")
			return
		}

		this.scheduleRestart(details, sessionId)
	}

	private scheduleRestart(details: RebuildDetails, sessionId?: string): void {
		const run = (context: SessionRebuildContext) => this.restartSession(details, context, sessionId)
		if (sessionId) this.options.rebuilds.request(details.reason, run, sessionId)
		else this.options.rebuilds.request(details.reason, run)
	}

	private async restartSession(details: RebuildDetails, context: SessionRebuildContext, sessionId?: string): Promise<void> {
		const activeSession = sessionId ? this.options.sessions.getSession(sessionId) : this.options.sessions.getActiveSession()
		if (!activeSession) {
			return
		}

		const { sdkHost: oldManager, sessionId: oldSessionId } = activeSession
		const messages = this.options.getMessages?.(oldSessionId) ?? this.options.messages
		const terminalMode = getEffectiveTerminalExecutionMode(
			this.options.stateManager.getGlobalStateKey("vscodeTerminalExecutionMode"),
		)
		Logger.log(`[SdkController] Restarting session ${oldSessionId} for ${details.description}; terminal mode ${terminalMode}`)

		messages.emitSessionEvents([], {
			type: "status",
			payload: { sessionId: oldSessionId, status: "running" },
		})

		try {
			const cwd = await this.options.getWorkspaceRoot()
			const modeValue = this.options.stateManager.getGlobalSettingsKey("mode")
			const mode: Mode =
				activeSession.startConfig?.mode ?? (modeValue === "plan" || modeValue === "act" ? modeValue : "act")
			const config = await this.options.sessionConfigBuilder.build({
				cwd,
				mode,
				...(activeSession.apiSnapshot
					? {
							apiSelection: activeSession.apiSnapshot.selection,
							apiConfiguration: activeSession.apiSnapshot.configuration,
						}
					: {}),
			})
			config.sessionId = oldSessionId

			const startInput = this.options.buildStartSessionInput(config, { cwd, mode })

			// Rebuilds may preserve the session ID, so identity is the only reliable
			// way to detect that another path replaced this session while we awaited.
			const currentSession = sessionId
				? this.options.sessions.getSession(sessionId)
				: this.options.sessions.getActiveSession()
			if (!currentSession) {
				Logger.log(`[SdkController] Active session ended during configuration restart (was ${oldSessionId}); aborting`)
				return
			}
			// A newer change for the same reason runs next, so this stale
			// configuration must not be installed.
			if (!context.isCurrent()) {
				Logger.log(`[SdkController] Configuration restart superseded before replacing ${oldSessionId}; aborting`)
				return
			}
			// The scheduler only starts a rebuild on an idle session with nothing
			// queued; a prompt the user sent while we awaited re-queues the rebuild.
			if (currentSession !== activeSession || currentSession.isRunning || currentSession.queuedPromptCount > 0) {
				Logger.log(
					`[SdkController] Active session changed or received a prompt during configuration restart (was ${oldSessionId}); deferring`,
				)
				this.scheduleRestart(details, sessionId)
				return
			}

			// Admission closes before the replacement reads the current history.
			const replaceSession = sessionId
				? this.options.sessions.replaceSession.bind(this.options.sessions)
				: this.options.sessions.replaceActiveSession.bind(this.options.sessions)
			const restartResult = await replaceSession({
				expectedSession: activeSession,
				startInput,
				loadInitialMessages: async () =>
					(await this.options.loadInitialMessages(oldManager, oldSessionId)) as InitialMessages,
				disposeReason: details.disposeReason,
			})
			if (!restartResult) {
				if (
					context.isCurrent() &&
					(sessionId ? this.options.sessions.getSession(sessionId) : this.options.sessions.getActiveSession()) ===
						activeSession
				)
					this.scheduleRestart(details, sessionId)
				return
			}

			const { startResult } = restartResult
			if (startResult.sessionId !== oldSessionId) {
				Logger.warn(
					`[SdkController] Configuration restart returned a new session ID (${startResult.sessionId}); preserving task ID ${oldSessionId} for UI continuity`,
				)
			}

			messages.emitSessionEvents([], {
				type: "status",
				payload: { sessionId: startResult.sessionId, status: "idle" },
			})

			await this.options.postStateToWebview()
			Logger.log(
				`[SdkController] Session restarted for ${details.description}: ${oldSessionId} -> ${startResult.sessionId}`,
			)
		} catch (error) {
			Logger.error(`[SdkController] Failed to restart session for ${details.description}:`, error)

			const errorMessage: ClineMessage = {
				ts: Date.now(),
				type: "say",
				say: "error",
				text: `${details.failureMessage} ${error instanceof Error ? error.message : String(error)}`,
				partial: false,
			}
			messages.appendAndEmit([errorMessage], {
				type: "status",
				payload: { sessionId: oldSessionId, status: "error" },
			})
			await this.options.postStateToWebview()
		}
	}
}
