import { isDeepStrictEqual } from "node:util"
import type { ApiConfiguration } from "@shared/api"
import type { Mode } from "@shared/storage/types"
import { resolveApiConfigurationForMode } from "@/core/controller/models/apiProfiles"
import type { StateManager } from "@/core/storage/StateManager"
import { toLegacyApiProvider } from "@/shared/model-catalog/provider-helpers"
import { Logger } from "@/shared/services/Logger"
import type { SdkMessageCoordinator } from "./sdk-message-coordinator"
import type { SdkSessionConfigBuilder } from "./sdk-session-config-builder"
import type { SdkSessionLifecycle } from "./sdk-session-lifecycle"
import type { SdkSessionRebuildScheduler } from "./sdk-session-rebuild-scheduler"
import type { SdkSessionHost } from "./session-host"
import type { TaskProxy } from "./task-proxy"
import type { VscodeSessionHost } from "./vscode-session-host"

type StartInput = Parameters<VscodeSessionHost["start"]>[0]
type InitialMessages = StartInput["initialMessages"]
type SessionConfig = Awaited<ReturnType<SdkSessionConfigBuilder["build"]>>

export interface SdkProviderChangeCoordinatorOptions {
	stateManager: StateManager
	sessions: SdkSessionLifecycle
	messages: SdkMessageCoordinator
	sessionConfigBuilder: SdkSessionConfigBuilder
	getTask: () => TaskProxy | undefined
	getWorkspaceRoot: () => Promise<string>
	loadInitialMessages: (sdkHost: SdkSessionHost, sessionId: string) => Promise<InitialMessages>
	buildStartSessionInput: (config: SessionConfig, input: { cwd: string; mode: Mode }) => StartInput
	postStateToWebview: () => Promise<void>
	rebuilds: Pick<SdkSessionRebuildScheduler, "request">
}

function effectiveConfiguration(configuration: ApiConfiguration, mode: Mode) {
	const resolved = resolveApiConfigurationForMode(configuration, mode)
	return Object.fromEntries(
		Object.entries(resolved)
			.filter(([key, value]) => value !== undefined && !key.startsWith(mode === "plan" ? "actMode" : "planMode"))
			.map(([key, value]) => [key, key === `${mode}ModeApiProvider` ? toLegacyApiProvider(value as string) : value]),
	)
}

export class SdkProviderChangeCoordinator {
	constructor(private readonly options: SdkProviderChangeCoordinatorOptions) {}

	handleApiConfigurationChanged(previous: ApiConfiguration, next: ApiConfiguration): void {
		const sessions =
			this.options.sessions.getSessions?.().values() ??
			[this.options.sessions.getActiveSession()].filter((session) => session !== undefined)
		for (const session of sessions) {
			const mode = session.startConfig?.mode ?? this.getCurrentMode()
			const before = effectiveConfiguration(previous, mode)
			const after = effectiveConfiguration(next, mode)
			if (isDeepStrictEqual(before, after)) continue
			this.options.rebuilds.request(
				"provider",
				(context) => this.performRestartActiveSessionForProviderChange(session.sessionId, context.isCurrent),
				session.sessionId,
			)
		}
	}

	async restartActiveSessionForProviderChange(): Promise<void> {
		await this.performRestartActiveSessionForProviderChange()
	}

	private async performRestartActiveSessionForProviderChange(sessionId?: string, isCurrent = () => true): Promise<void> {
		const activeSession = sessionId
			? (this.options.sessions.getSession?.(sessionId) ??
				(this.options.sessions.getActiveSession()?.sessionId === sessionId
					? this.options.sessions.getActiveSession()
					: undefined))
			: this.options.sessions.getActiveSession()
		if (!activeSession) {
			return
		}

		const { sdkHost: oldManager, sessionId: oldSessionId } = activeSession
		const cwd = await this.options.getWorkspaceRoot()
		const mode = activeSession.startConfig?.mode ?? this.getCurrentMode()

		Logger.log(`[SdkController] Restarting session ${oldSessionId} for provider change`)

		try {
			const config = await this.options.sessionConfigBuilder.build({ cwd, mode })
			config.sessionId = oldSessionId

			const initialMessages = await this.options.loadInitialMessages(oldManager, oldSessionId)
			const startInput = this.options.buildStartSessionInput(config, { cwd, mode })
			if (!isCurrent()) return
			const replace =
				this.options.sessions.replaceSession?.bind(this.options.sessions) ??
				this.options.sessions.replaceActiveSession.bind(this.options.sessions)
			const restartResult = await replace({
				expectedSession: activeSession,
				startInput,
				...(initialMessages ? { initialMessages } : {}),
				disposeReason: "providerChange",
			})
			if (!restartResult) {
				const retained = this.options.sessions.getSession?.(oldSessionId)
				if (isCurrent() && retained === activeSession && (retained.isRunning || retained.queuedPromptCount > 0)) {
					this.options.rebuilds.request(
						"provider",
						(context) => this.performRestartActiveSessionForProviderChange(oldSessionId, context.isCurrent),
						oldSessionId,
					)
				}
				return
			}

			const { startResult } = restartResult
			const task = this.options.getTask()
			if (task?.taskId === oldSessionId && task.taskId !== startResult.sessionId) {
				Logger.warn(
					`[SdkController] Provider restart returned a new session ID (${startResult.sessionId}); updating task proxy`,
				)
				task.taskId = startResult.sessionId
			}

			await this.options.postStateToWebview()
			Logger.log(`[SdkController] Session restarted for provider change: ${oldSessionId} -> ${startResult.sessionId}`)
		} catch (error) {
			Logger.error("[SdkController] Failed to restart session for provider change:", error)
			if (this.options.sessions.getActiveSession()?.sessionId === oldSessionId)
				this.options.messages.appendAndEmit(
					[
						{
							ts: Date.now(),
							type: "say",
							say: "error",
							text: `Failed to reload provider configuration: ${
								error instanceof Error ? error.message : String(error)
							}. The active session may still use the previous provider.`,
							partial: false,
						},
					],
					{ type: "status", payload: { sessionId: oldSessionId, status: "error" } },
				)
			this.options.sessions.setStatus?.(oldSessionId, "error")
			await this.options.postStateToWebview()
		}
	}

	private getCurrentMode(): Mode {
		return this.options.stateManager.getGlobalSettingsKey("mode") === "plan" ? "plan" : "act"
	}
}
