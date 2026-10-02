import type { ClineMessage, TurnPhase } from "@shared/ExtensionMessage"
import type { HistoryItem } from "@shared/HistoryItem"
import { Logger } from "@/shared/services/Logger"
import type { SdkInteractionCoordinator } from "./sdk-interaction-coordinator"
import type { SdkMessageCoordinator } from "./sdk-message-coordinator"
import { isAbortError, type SdkSessionLifecycle } from "./sdk-session-lifecycle"
import type { SdkSessionRebuildScheduler } from "./sdk-session-rebuild-scheduler"
import type { SdkTaskHistory } from "./sdk-task-history"
import { createTaskProxy, type TaskProxy } from "./task-proxy"

export interface SdkTaskControlCoordinatorOptions {
	sessions: SdkSessionLifecycle
	interactions: SdkInteractionCoordinator
	messages: SdkMessageCoordinator
	taskHistory: SdkTaskHistory
	getTask: () => TaskProxy | undefined
	setTask: (task: TaskProxy | undefined) => void
	onAskResponse: (text?: string, images?: string[], files?: string[]) => Promise<void>
	resetMessageTranslator: () => void
	postStateToWebview: () => Promise<void>
	rebuilds: Pick<SdkSessionRebuildScheduler, "runTaskTransition">
	/**
	 * Drops the StateManager's task-scoped settings overlay (persisting pending
	 * writes first). Task settings — e.g. autoApprovalSettings written by
	 * toggling auto-approve while a task is open — shadow global settings in
	 * getGlobalSettingsKey(). If the overlay outlives the task view, later
	 * global updates are accepted but never surface in posted state (the stale
	 * overlay version wins), which froze the auto-approve checkboxes after
	 * "New Task" (#13260). Must run whenever the task view is cleared or
	 * switched to another task.
	 */
	clearTaskSettings: () => Promise<void>
	/**
	 * Sets the authoritative turn phase. showTaskWithId must derive the phase
	 * from the reopened conversation (resumable/completed) — leaving the
	 * previous task's phase in place hides the Resume button for interrupted
	 * sessions opened from History (and can leak stale buttons in general).
	 */
	setTurnPhase: (phase: TurnPhase, anchorTs?: number) => void
	/**
	 * Raise the cancel fence SYNCHRONOUSLY before aborting the SDK session: bump the epoch so any
	 * straggler events the SDK emits after the abort request carry the old epoch (and are dropped
	 * by the webview), and mark the active turn cancelled so the session-event coordinator
	 * suppresses its remaining DISPLAY output (usage is still accounted).
	 */
	raiseCancelFence?: () => void
	focusLiveTask?: (taskId: string, historyItem?: HistoryItem) => boolean
	/**
	 * Returns a displayable HistoryItem for a session that is still live but has
	 * no persisted history record yet. A just-started task only reaches the
	 * history listing once Core persists the first send, so without this the
	 * inbox drops a backgrounded brand-new chat and it cannot be reopened.
	 */
	getLiveTaskItem?: (taskId: string) => HistoryItem | undefined
	setTaskMode?: (mode: "plan" | "act") => void
	/**
	 * Restores the task's last-used saved-configuration selection (profile +
	 * reasoning effort per mode) into the global per-mode keys so the composer
	 * shows what this chat runs on. Must not notify provider-change rebuilds:
	 * running sessions keep their own pinned selection.
	 */
	applyTaskApiSelection?: (historyItem: HistoryItem, mode?: "plan" | "act") => void
}

export class SdkTaskControlCoordinator {
	/**
	 * Generation counter for task-view mutations (showTaskWithId / clearTask).
	 * showTaskWithId awaits several reads before installing the task proxy; a
	 * request that loses the race to a newer mutation abandons installation at
	 * the next fence check so the user's latest selection always wins.
	 */
	private taskViewGeneration = 0

	constructor(private readonly options: SdkTaskControlCoordinatorOptions) {}

	async cancelClineTaskOnSignOut(isClineManagedProvider: boolean): Promise<void> {
		const activeSession = this.options.sessions.getActiveSession()
		if (!isClineManagedProvider || !activeSession?.isRunning) {
			return
		}

		await this.cancelTask()
	}

	async cancelTask(appendResume = true, interject?: { text: string; images?: string[]; files?: string[] }): Promise<void> {
		this.options.interactions.clearPending("Task cancelled")

		const activeSession = this.options.sessions.getActiveSession()
		if (!activeSession) {
			Logger.warn("[SdkController] cancelTask: No active session")
			return
		}

		const { sdkHost, sessionId } = activeSession

		// FENCE FIRST: raise the cancel fence synchronously BEFORE awaiting the abort. Any event
		// the SDK emits after this point carries the old epoch (dropped by the webview) and is
		// marked cancelled (display suppressed by the session-event coordinator; usage still
		// accounted). Order matters — aborting first would leave a window where a straggler gets
		// the new epoch.
		this.options.raiseCancelFence?.()

		if (interject) {
			this.options.sessions.fireAndForgetSend(
				sdkHost,
				sessionId,
				interject.text,
				interject.images,
				interject.files,
				"interject",
			)
			return
		}

		try {
			this.options.sessions.cancelHeldSends(sessionId)
			await sdkHost.abort(sessionId)
		} catch (error) {
			if (!isAbortError(error)) {
				Logger.error("[SdkController] Failed to abort session:", error)
			} else {
				Logger.debug(`[SdkController] AbortError during cancelTask (expected): ${sessionId}`)
			}
		}

		this.options.sessions.setRunning(false)

		const resumeMessage: ClineMessage = {
			ts: Date.now(),
			type: "ask",
			ask: "resume_task",
			text: "",
			partial: false,
		}
		if (appendResume)
			this.options.messages.appendAndEmit([resumeMessage], { type: "status", payload: { sessionId, status: "cancelled" } })

		await this.options.postStateToWebview()
		Logger.log(`[SdkController] Task cancelled: ${sessionId}`)
	}

	async clearTask(): Promise<void> {
		const activeSession = this.options.sessions.getActiveSession()
		if (activeSession) this.options.sessions.cancelHeldSends(activeSession.sessionId)
		// Supersede any in-flight showTaskWithId so it cannot re-install a task
		// after the user cleared the view (e.g. clicked New Task).
		const generation = ++this.taskViewGeneration
		await this.options.rebuilds.runTaskTransition(async () => {
			if (generation !== this.taskViewGeneration) {
				return
			}

			this.options.sessions.focusSession()

			const task = this.options.getTask()
			if (task) {
				// SDK session persistence owns conversation history. Do not write classic
				// ui_messages.json here; history viewing reloads from SDK readMessages().
				this.options.messages.cancelPendingSave()
				this.options.setTask(undefined)
			}

			await this.options.clearTaskSettings()
		})
	}

	/**
	 * Opens a task from History. The view generation is allocated synchronously
	 * on entry — BEFORE any asynchronous work, including the history lookup —
	 * so the newest user selection always holds the newest generation and every
	 * older in-flight request self-abandons at its next fence check. (The
	 * lookup used to live in SdkController before the generation was taken; a
	 * stalled preflight could then re-enter with a NEWER generation than a
	 * later selection and replace it.)
	 *
	 * Returns the task's HistoryItem, or undefined when the task is unknown.
	 * A superseded call still returns the item (the lookup succeeded); it just
	 * skips mutating the task view.
	 */
	async showTaskWithId(taskId: string): Promise<HistoryItem | undefined> {
		this.options.sessions.assertTaskAvailable?.(taskId)
		const generation = ++this.taskViewGeneration
		const isSuperseded = (): boolean => {
			if (generation === this.taskViewGeneration) {
				return false
			}
			Logger.debug(`[SdkController] showTaskWithId superseded by a newer selection; skipping: ${taskId}`)
			return true
		}

		let historyItem: HistoryItem | undefined
		try {
			historyItem = await this.options.taskHistory.findHistoryItem(taskId)
		} catch (error) {
			Logger.error(`[SdkController] Failed to look up task in history: ${taskId}`, error)
			return undefined
		}
		if (!historyItem) {
			// A live session can outrun its persisted record (Core only writes the
			// row when the first send lands). Focusing it through the live path
			// keeps a backgrounded brand-new chat reopenable from the inbox.
			historyItem = this.options.getLiveTaskItem?.(taskId)
		}
		if (!historyItem) {
			Logger.error(`[SdkController] Task not found in history: ${taskId}`)
			return undefined
		}

		// A superseded request must not change the focus selected by a newer request.
		if (isSuperseded()) {
			return historyItem
		}

		await this.options.rebuilds.runTaskTransition(async () => {
			try {
				if (isSuperseded()) return historyItem
				await this.options.clearTaskSettings()
				if (isSuperseded()) return historyItem
				if (this.options.focusLiveTask?.(taskId, historyItem)) {
					await this.options.postStateToWebview()
					return historyItem
				}
				this.options.sessions.focusSession(taskId)

				// Load messages before installing the new task proxy so any concurrent
				// postStateToWebview() caller never sees the new id with empty messages.
				const isLegacyTask = await this.options.taskHistory.isLegacyTask(taskId)
				const sessionStatus = isLegacyTask ? undefined : await this.options.taskHistory.getSessionStatus(taskId)
				const rawMessages = await this.options.taskHistory.getClineMessages(taskId)
				const taskMode = await this.options.taskHistory.getTaskMode?.(taskId)
				if (isSuperseded()) {
					return historyItem
				}
				this.options.sessions.assertTaskAvailable?.(taskId)
				const messages = this.options.messages.finalizeMessagesForSave(rawMessages)
				const cleanedMessages = isLegacyTask
					? this.appendLegacyTaskWarningAndResumeMessage(messages)
					: messages.length > 0
						? this.appendFreshResumeMessage(messages, sessionStatus)
						: []

				const task = createTaskProxy(
					taskId,
					(text?: string, images?: string[], files?: string[]) => this.options.onAskResponse(text, images, files),
					() => this.cancelTask(),
				)
				if (cleanedMessages.length > 0) {
					task.messageStateHandler.addMessages(cleanedMessages)
				}
				if (taskMode) this.options.setTaskMode?.(taskMode)
				this.options.applyTaskApiSelection?.(historyItem, taskMode)
				this.options.setTask(task)

				// Derive the turn phase from the appended resume ask. The webview
				// renders footer buttons from the authoritative TurnState, so without
				// this the phase left over from the previous context (often "idle")
				// hides the Resume button for interrupted/failed sessions.
				const lastMessage = cleanedMessages.at(-1)
				if (lastMessage?.type === "ask" && lastMessage.ask === "resume_completed_task") {
					this.options.setTurnPhase("completed", lastMessage.ts)
				} else if (lastMessage?.type === "ask" && lastMessage.ask === "resume_task") {
					this.options.setTurnPhase("resumable", lastMessage.ts)
				} else {
					this.options.setTurnPhase("idle")
				}

				if (cleanedMessages.length > 0) {
					Logger.log(`[SdkController] Loaded ${cleanedMessages.length} messages for task: ${taskId}`)
				} else {
					Logger.log(`[SdkController] No messages found for task: ${taskId}`)
				}

				// The final state update below includes the loaded clineMessages. Avoid pushing
				// each historical message through the partial-message stream one-by-one; for
				// long tasks that serial loop can dominate history-open latency.
				await this.options.postStateToWebview()
				Logger.log(`[SdkController] Showing task: ${taskId}`)
			} catch (error) {
				Logger.error("[SdkController] Failed to show task:", error)
			}
			return undefined
		})
		return historyItem
	}

	private appendFreshResumeMessage(messages: ClineMessage[], sessionStatus?: string): ClineMessage[] {
		// The persisted session status is the only reliable completion signal:
		// SDK conversations do not record a completion tool call in the
		// transcript (a completed turn and a turn interrupted mid-stream both
		// end with plain assistant text), and history rendering appends a
		// synthetic trailing ask:"completion_result" either way, so the message
		// tail cannot be used. When the status is unknown (e.g. a transient
		// read failure), default to the Resume affordance: resuming a completed
		// task is harmless, while hiding Resume on an interrupted one is the
		// data-loss illusion this exists to prevent.
		const resumeAsk = sessionStatus === "completed" ? "resume_completed_task" : "resume_task"
		const cleanedMessages = messages.filter((m) => m.ask !== "resume_task" && m.ask !== "resume_completed_task")
		cleanedMessages.push({
			ts: Date.now(),
			type: "ask",
			ask: resumeAsk,
			text: "",
		})
		return cleanedMessages
	}

	private appendLegacyTaskWarningAndResumeMessage(messages: ClineMessage[]): ClineMessage[] {
		const cleanedMessages = messages.filter((m) => m.ask !== "resume_task" && m.ask !== "resume_completed_task")
		const now = Date.now()
		cleanedMessages.push(
			{
				ts: now,
				type: "say",
				say: "text",
				text: "⚠️ This is a legacy task. It may not work as well because tool names may have changed.",
			},
			{
				ts: now + 1,
				type: "ask",
				ask: "resume_task",
				text: "",
			},
		)
		return cleanedMessages
	}
}
