import { isDeepStrictEqual } from "node:util"
import type { ApiConfiguration } from "@shared/api"
import type { TaskApiSelection } from "@shared/api-profiles"
import type { Mode } from "@shared/storage/types"
import {
	readApiConfigProfiles,
	resolveApiConfigurationForMode,
	resolveApiConfigurationForTaskSelection,
} from "@/core/controller/models/apiProfiles"
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
	/**
	 * The task's last-used saved-configuration selection, if any. Sessions pin
	 * to it so global selection changes (e.g. focusing a different chat) never
	 * rewrite a running session's provider/model.
	 */
	getTaskApiSelection?: (taskId: string) => TaskApiSelection | undefined
	onSelectionRebuilt?: (taskId: string, selection: TaskApiSelection, requestedSelection?: TaskApiSelection) => void
	postStateToWebview: () => Promise<void>
	rebuilds: Pick<SdkSessionRebuildScheduler, "request">
}

function filterModeConfiguration(resolved: ApiConfiguration, mode: Mode) {
	return {
		[`${mode}ModeReasoningEffort`]: resolved[`${mode}ModeReasoningEffort`] ?? "none",
		...Object.fromEntries(
			Object.entries(resolved)
				.filter(([key, value]) => value !== undefined && !key.startsWith(mode === "plan" ? "actMode" : "planMode"))
				.map(([key, value]) => [key, key === `${mode}ModeApiProvider` ? toLegacyApiProvider(value as string) : value]),
		),
	}
}

export class SdkProviderChangeCoordinator {
	constructor(private readonly options: SdkProviderChangeCoordinatorOptions) {}

	handleApiConfigurationChanged(
		previous: ApiConfiguration,
		next: ApiConfiguration,
		previousSelections?: ReadonlyMap<string, TaskApiSelection | undefined>,
	): void {
		const sessions =
			this.options.sessions.getSessions?.().values() ??
			[this.options.sessions.getActiveSession()].filter((session) => session !== undefined)
		for (const session of sessions) {
			const mode = session.startConfig?.mode ?? this.getCurrentMode()
			const selection = this.options.getTaskApiSelection?.(session.sessionId) ?? session.apiSnapshot?.selection
			const beforeSelection = previousSelections?.has(session.sessionId)
				? previousSelections.get(session.sessionId)
				: selection
			const before = filterModeConfiguration(
				session.apiSnapshot?.configuration ??
					(beforeSelection
						? resolveApiConfigurationForTaskSelection(this.options.stateManager, previous, mode, beforeSelection)
						: resolveApiConfigurationForMode(previous, mode)),
				mode,
			)
			const after = filterModeConfiguration(
				selection
					? resolveApiConfigurationForTaskSelection(
							this.options.stateManager,
							next,
							mode,
							this.reconcileSelection(selection),
						)
					: resolveApiConfigurationForMode(next, mode),
				mode,
			)
			const resolvedSelection = selection ? this.reconcileSelection(selection) : undefined
			const profileKey = mode === "plan" ? "askProfileId" : "actProfileId"
			const changed =
				!isDeepStrictEqual(before, after) ||
				(session.apiSnapshot && session.apiSnapshot.selection[profileKey] !== resolvedSelection?.[profileKey])
			if (!changed) {
				if (resolvedSelection) this.options.onSelectionRebuilt?.(session.sessionId, resolvedSelection, selection)
				continue
			}
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
			// A session pinned to a task selection rebuilds against its own
			// profile, not whichever configuration is globally selected now.
			const requestedSelection = this.options.getTaskApiSelection?.(oldSessionId) ?? activeSession.apiSnapshot?.selection
			const selection = requestedSelection ? this.reconcileSelection(requestedSelection) : undefined
			const apiConfiguration = selection
				? resolveApiConfigurationForTaskSelection(
						this.options.stateManager,
						this.options.stateManager.getApiConfiguration(mode),
						mode,
						selection,
					)
				: undefined
			const config = await this.options.sessionConfigBuilder.build({
				cwd,
				mode,
				...(apiConfiguration ? { apiConfiguration, apiSelection: selection } : {}),
			})
			config.sessionId = oldSessionId

			const startInput = this.options.buildStartSessionInput(config, { cwd, mode })
			if (!isCurrent()) return
			const replace =
				this.options.sessions.replaceSession?.bind(this.options.sessions) ??
				this.options.sessions.replaceActiveSession.bind(this.options.sessions)
			let selectionCommitted = false
			const restartResult = await replace({
				expectedSession: activeSession,
				startInput,
				loadInitialMessages: async () =>
					(await this.options.loadInitialMessages(oldManager, oldSessionId)) as InitialMessages,
				disposeReason: "providerChange",
				onReplaced: () => {
					if (selection) this.options.onSelectionRebuilt?.(oldSessionId, selection, requestedSelection)
					selectionCommitted = true
				},
			})
			if (!restartResult) {
				const retained = this.options.sessions.getSession?.(oldSessionId)
				if (isCurrent() && retained === activeSession) {
					this.options.rebuilds.request(
						"provider",
						(context) => this.performRestartActiveSessionForProviderChange(oldSessionId, context.isCurrent),
						oldSessionId,
					)
				}
				return
			}

			const { startResult } = restartResult
			if (selection && !selectionCommitted) this.options.onSelectionRebuilt?.(oldSessionId, selection, requestedSelection)
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

	private reconcileSelection(selection: TaskApiSelection): TaskApiSelection {
		const profiles = readApiConfigProfiles(this.options.stateManager)
		const known = new Set(profiles.map((profile) => profile.id))
		const resolved = { ...selection }
		for (const key of ["askProfileId", "actProfileId"] as const) {
			if (resolved[key] && !known.has(resolved[key])) resolved[key] = profiles[0]?.id
		}
		return resolved
	}

	private getCurrentMode(): Mode {
		return this.options.stateManager.getGlobalSettingsKey("mode") === "plan" ? "plan" : "act"
	}
}
