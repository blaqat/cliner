import { getProviderAuthStorageId } from "@cline/core"
import { createSessionId } from "@cline/shared"
import type { TaskApiSelection } from "@shared/api-profiles"
import { CLINE_ACCOUNT_AUTH_ERROR_MESSAGE } from "@shared/ClineAccount"
import type { ClineMessage } from "@shared/ExtensionMessage"
import type { HistoryItem } from "@shared/HistoryItem"
import type { Settings } from "@shared/storage/state-keys"
import type { Mode } from "@shared/storage/types"
import { captureTaskApiSelection } from "@/core/controller/models/apiProfiles"
import type { StateManager } from "@/core/storage/StateManager"
import { Logger } from "@/shared/services/Logger"
import { isDirectory } from "@/utils/fs"
import { PROVIDER_FAILURE_ERROR_TYPE, PROVIDER_FAILURE_PHASE, type ProviderFailureTelemetry } from "./provider-failure-telemetry"
import type { SdkMessageCoordinator } from "./sdk-message-coordinator"
import type { SdkSessionConfigBuilder } from "./sdk-session-config-builder"
import type { SdkSessionLifecycle } from "./sdk-session-lifecycle"
import { historyItemToSessionMetadata, type SdkTaskHistory } from "./sdk-task-history"
import type { SdkSessionHost } from "./session-host"
import { createTaskProxy, type TaskProxy } from "./task-proxy"
import type { VscodeSessionHost } from "./vscode-session-host"

type StartInput = Parameters<VscodeSessionHost["start"]>[0]
type InitialMessages = StartInput["initialMessages"]
type SessionConfig = Awaited<ReturnType<SdkSessionConfigBuilder["build"]>>

function usesClineAccountAuth(providerId: string): boolean {
	return getProviderAuthStorageId(providerId) === "cline"
}

export interface SdkTaskStartCoordinatorOptions {
	stateManager: StateManager
	sessions: SdkSessionLifecycle
	messages: SdkMessageCoordinator
	taskHistory: SdkTaskHistory
	sessionConfigBuilder: SdkSessionConfigBuilder
	buildStartSessionInput: (
		config: SessionConfig,
		input: {
			prompt?: string
			images?: string[]
			files?: string[]
			historyItem?: HistoryItem
			taskSettings?: Partial<Settings>
			cwd: string
			mode: Mode
		},
	) => StartInput
	createHistoryItemFromSession: (sessionId: string, prompt: string, modelId?: string, cwd?: string) => HistoryItem
	clearTask: () => Promise<void>
	setTask: (task: TaskProxy | undefined) => void
	/**
	 * Returns (creating if needed) the per-task session context for a task that
	 * is NOT being focused — used by background starts to own the transcript,
	 * turn state, and event routing without touching the view.
	 */
	createTaskContext?: (
		taskId: string,
		task?: TaskProxy,
	) => {
		task: TaskProxy
		messages: Pick<SdkMessageCoordinator, "appendAndEmit">
	}
	onAskResponse: (text?: string, images?: string[], files?: string[]) => Promise<void>
	onCancelTask: () => Promise<void>
	getWorkspaceRoot: () => Promise<string>
	createTempSessionHost: () => Promise<SdkSessionHost>
	loadInitialMessages: (reader: SdkSessionHost, taskId: string) => Promise<unknown[] | undefined>
	resolveContextMentions: (text: string) => Promise<string>
	isClineManagedProviderActive: () => boolean
	emitClineAuthError: (task?: string) => void
	captureProviderApiError?: (event: ProviderFailureTelemetry) => void
	/**
	 * Pins the current global per-mode selection onto the new task's session
	 * context and persists it, so the chat keeps running on (and reopens to)
	 * the configuration it was started with.
	 */
	recordTaskApiSelection?: (taskId: string, selection: TaskApiSelection, mode: Mode) => void
	postStateToWebview: () => Promise<void>
}

export class SdkTaskStartCoordinator {
	constructor(private readonly options: SdkTaskStartCoordinatorOptions) {}

	async initTask(
		prompt?: string,
		images?: string[],
		files?: string[],
		historyItem?: HistoryItem,
		taskSettings?: Partial<Settings>,
		options?: { background?: boolean },
	): Promise<string | undefined> {
		Logger.log(`[SdkController] initTask called: "${prompt?.substring(0, 50)}"`)
		const background = options?.background === true
		let taskSessionId: string | undefined
		let providerId: string | undefined
		let modelId: string | undefined
		let context: ReturnType<NonNullable<SdkTaskStartCoordinatorOptions["createTaskContext"]>> | undefined
		try {
			// A background start must not touch the task view: no focus change, no
			// task-settings overlay drop, no clearing of what the user is looking at.
			if (!background) await this.options.clearTask()

			const cwd = await this.options.getWorkspaceRoot()
			const mode = this.getCurrentMode()
			const apiSelection = captureTaskApiSelection(this.options.stateManager)
			Logger.log(`[SdkController] Building session config: mode=${mode}, cwd=${cwd}`)
			const config = await this.options.sessionConfigBuilder.build({
				prompt,
				images,
				files,
				historyItem,
				taskSettings,
				cwd,
				mode,
				apiSelection,
			})
			providerId = config.providerId
			modelId = config.modelId

			Logger.log(
				`[SdkController] Session config: provider=${config.providerId}, model=${config.modelId}, hasApiKey=${!!config.apiKey}`,
			)

			if (usesClineAccountAuth(config.providerId) && !config.apiKey) {
				Logger.warn(
					`[SdkController] ${config.providerId} provider selected but no Cline auth token — emitting auth error`,
				)
				// No task/session id exists yet, so this preflight auth UI path is
				// intentionally not recorded as task-joinable provider error telemetry.
				this.options.emitClineAuthError(prompt)
				return undefined
			}

			taskSessionId = config.sessionId?.trim() || createSessionId()
			const configWithSessionId = {
				...config,
				sessionId: taskSessionId,
			}

			const startInput = this.options.buildStartSessionInput(configWithSessionId, {
				prompt: prompt,
				images,
				files,
				historyItem,
				taskSettings,
				cwd,
				mode,
			})

			startInput.sessionMetadata = { ...startInput.sessionMetadata, apiSelection }
			// Focused starts install the task proxy as the current view; background
			// starts park it in the per-task context so its transcript and turn state
			// accumulate offscreen and the chat appears in the inbox as running.
			context = background ? this.options.createTaskContext?.(taskSessionId) : undefined
			if (background && !context) throw new Error("Background task contexts are unavailable")
			const task = context?.task ?? this.createAndSetTask(taskSessionId)
			const messageTarget: Pick<SdkMessageCoordinator, "appendAndEmit"> = context?.messages ?? this.options.messages
			this.emitInitialTaskMessage(messageTarget, taskSessionId, prompt ?? "", images, files)

			// The turn phase was already set to "streaming" (in SdkController.initTask), but the
			// webview only learns the phase through a full state post. Ship one now, in parallel
			// with the potentially slow session startup below, so the chat shows the thinking
			// indicator as soon as the task message lands instead of after startNewSession settles.
			this.options.postStateToWebview().catch((error) => {
				Logger.error("[SdkController] Failed to post state after emitting initial task message:", error)
			})

			this.options.recordTaskApiSelection?.(taskSessionId, apiSelection, mode)
			const { startResult, sdkHost } = background
				? await this.options.sessions.startNewSession(startInput, { focus: false })
				: await this.options.sessions.startNewSession(startInput)
			if (startResult.sessionId !== taskSessionId) {
				Logger.warn(
					`[SdkController] SDK returned session id ${startResult.sessionId} after requested id ${taskSessionId}`,
				)
				task.taskId = startResult.sessionId
				taskSessionId = startResult.sessionId
			}

			const newHistoryItem = {
				...this.options.createHistoryItemFromSession(taskSessionId, prompt ?? "", configWithSessionId.modelId, cwd),
				apiSelection,
			}
			await this.options.taskHistory.updateTaskHistoryItem(newHistoryItem)
			this.options.recordTaskApiSelection?.(taskSessionId, apiSelection, mode)
			await this.options.postStateToWebview()

			if (prompt?.trim() || images?.length || files?.length) {
				Logger.log(`[SdkController] Sending prompt to session: ${taskSessionId}`)
				const resolvedTask = await this.options.resolveContextMentions(prompt || "")
				this.options.sessions.fireAndForgetSend(sdkHost, taskSessionId, resolvedTask, images, files)
			}

			Logger.log(`[SdkController] Task initialized: ${taskSessionId}`)
			return taskSessionId
		} catch (error) {
			this.options.captureProviderApiError?.({
				sessionId: taskSessionId,
				error,
				providerId,
				modelId,
				errorType: PROVIDER_FAILURE_ERROR_TYPE.TASK_INIT,
				failurePhase: PROVIDER_FAILURE_PHASE.PREFLIGHT,
			})
			this.handleInitError(error, taskSessionId, context?.messages)
			await this.options.postStateToWebview().catch((postError) => {
				Logger.error("[SdkController] Failed to post state after init error:", postError)
			})
			return undefined
		}
	}

	async reinitExistingTaskFromId(taskId: string): Promise<void> {
		try {
			await this.options.clearTask()

			const historyItem = await this.options.taskHistory.findHistoryItem(taskId)
			if (!historyItem) {
				Logger.error(`[SdkController] Task not found in history: ${taskId}`)
				return
			}

			// A task's stored cwd may have been deleted/moved since the task ran
			// (or migrated from another machine) — feeding a stale path into the
			// session bootstrap makes workspace init fail. Fall back to the live
			// workspace root instead.
			const storedCwd = historyItem.cwdOnTaskInitialization
			const cwd = storedCwd && (await isDirectory(storedCwd)) ? storedCwd : await this.options.getWorkspaceRoot()
			const apiSelection = captureTaskApiSelection(this.options.stateManager)
			const config = await this.options.sessionConfigBuilder.build({
				cwd,
				mode: "act",
				apiSelection,
			})

			const tempManager = await this.options.createTempSessionHost()
			const initialMessages = await this.options.loadInitialMessages(tempManager, taskId)
			await tempManager.dispose("readMessages")

			const { startResult } = await this.options.sessions.startNewSession({
				config,
				interactive: true,
				...(initialMessages ? { initialMessages: initialMessages as InitialMessages } : {}),
				sessionMetadata: historyItemToSessionMetadata(historyItem, config.modelId),
			})

			this.createAndSetTask(startResult.sessionId)
			this.options.recordTaskApiSelection?.(startResult.sessionId, apiSelection, "act")
			await this.options.postStateToWebview()

			Logger.log(`[SdkController] Task resumed: ${taskId} → ${startResult.sessionId}`)
		} catch (error) {
			this.handleReinitError(taskId, error)
		}
	}

	private getCurrentMode(): Mode {
		const m = this.options.stateManager.getGlobalSettingsKey("mode")
		return m === "plan" ? m : "act"
	}

	private createAndSetTask(sessionId: string): TaskProxy {
		const task = createTaskProxy(
			sessionId,
			(text?: string, images?: string[], files?: string[]) => this.options.onAskResponse(text, images, files),
			() => this.options.onCancelTask(),
		)
		this.options.setTask(task)
		return task
	}

	private emitInitialTaskMessage(
		messages: Pick<SdkMessageCoordinator, "appendAndEmit">,
		sessionId: string,
		task: string,
		images?: string[],
		files?: string[],
	): void {
		// Attachments must ride on the authoritative task message: the webview's
		// optimistic pending copy is only cleared once an identical message (text
		// AND images/files) arrives from the extension. Omitting them left the
		// optimistic message unconfirmed forever, so it was re-injected into the
		// transcript even after "New Task" cleared it (#12924).
		const taskMessage: ClineMessage = {
			ts: Date.now(),
			type: "say",
			say: "task",
			text: task,
			...(images?.length ? { images } : {}),
			...(files?.length ? { files } : {}),
			partial: false,
		}
		messages.appendAndEmit([taskMessage], {
			type: "status",
			payload: { sessionId, status: "running" },
		})
	}

	private handleInitError(
		error: unknown,
		sessionId?: string,
		messages: Pick<SdkMessageCoordinator, "appendAndEmit"> = this.options.messages,
	): void {
		const errorDetails =
			error instanceof Error ? `${error.name}: ${error.message}\n${error.stack?.substring(0, 500)}` : String(error)
		Logger.error(`[SdkController] Failed to init task: ${errorDetails}`)
		;(globalThis as Record<string, unknown>).__cline_last_init_error = errorDetails
		;(globalThis as Record<string, unknown>).__cline_last_init_error_raw = error
		messages.appendAndEmit(
			[
				{
					ts: Date.now(),
					type: "say",
					say: "error",
					text: `Failed to start task: ${error instanceof Error ? error.message : String(error)}`,
					partial: false,
				},
			],
			{ type: "status", payload: { sessionId: sessionId ?? "", status: "error" } },
		)
	}

	private handleReinitError(taskId: string, error: unknown): void {
		Logger.error("[SdkController] Failed to reinit task:", error)

		const reinitErrorMsg = error instanceof Error ? error.message : String(error)
		const isClineAuthReinit =
			this.options.isClineManagedProviderActive() &&
			(reinitErrorMsg.includes(CLINE_ACCOUNT_AUTH_ERROR_MESSAGE) ||
				reinitErrorMsg.toLowerCase().includes("missing api key") ||
				reinitErrorMsg.toLowerCase().includes("unauthorized"))

		if (isClineAuthReinit) {
			this.options.emitClineAuthError()
			return
		}

		this.options.messages.emitSessionEvents(
			[
				{
					ts: Date.now(),
					type: "say",
					say: "error",
					text: `Failed to resume task: ${reinitErrorMsg}`,
					partial: false,
				},
			],
			{ type: "status", payload: { sessionId: taskId, status: "error" } },
		)
	}
}
