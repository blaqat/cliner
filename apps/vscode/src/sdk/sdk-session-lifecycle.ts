import type {
	CoreSessionEvent,
	ITelemetryService,
	PreparedRemoteConfigCoreIntegration,
	RestoreInput,
	RestoreResult,
	StartSessionResult,
} from "@cline/core"
import { formatModeSwitchNotice, type ModeSwitchNotice } from "@cline/shared"
import { StateManager } from "@/core/storage/StateManager"
import type { VscodeTerminalManager } from "@/hosts/vscode/terminal/VscodeTerminalManager"
import { McpHub } from "@/services/mcp/McpHub"
import { Logger } from "@/shared/services/Logger"
import type { ActiveSession } from "./cline-session-factory"
import { getSessionApiSnapshot } from "./cline-session-factory"
import type { SdkForegroundCommandCoordinator } from "./sdk-foreground-command-coordinator"
import { buildToolPolicies } from "./sdk-tool-policies"
import type { SdkSessionHost } from "./session-host"
import { VscodeSessionHost } from "./vscode-session-host"

type RequestToolApprovalHandler = NonNullable<Parameters<typeof VscodeSessionHost.create>[0]["requestToolApproval"]>
type AskQuestionHandler = NonNullable<Parameters<typeof VscodeSessionHost.create>[0]["askQuestion"]>
type EditorExecutorHandler = NonNullable<Parameters<typeof VscodeSessionHost.create>[0]["editorExecutor"]>
type ApplyPatchExecutorHandler = NonNullable<Parameters<typeof VscodeSessionHost.create>[0]["applyPatchExecutor"]>
type ReadFileExecutorHandler = NonNullable<Parameters<typeof VscodeSessionHost.create>[0]["readFileExecutor"]>

export interface SdkSessionLifecycleOptions {
	mcpHub: McpHub
	requestToolApproval: RequestToolApprovalHandler
	askQuestion: AskQuestionHandler
	/** Custom `editor` executor (diff-view edit pipeline); replaces the SDK's disk writer. */
	editorExecutor?: EditorExecutorHandler
	/** Custom `apply_patch` executor (reverts the diff preview, then applies via the SDK default). */
	applyPatchExecutor?: ApplyPatchExecutorHandler
	/** Custom `read_files` executor (resolves relative paths against the workspace root). */
	readFileExecutor?: ReadFileExecutorHandler
	onSessionEvent: (event: CoreSessionEvent) => void
	/** Lazy factory for the VscodeTerminalManager (foreground terminal support). */
	getTerminalManager?: () => VscodeTerminalManager
	/** Registry of in-flight foreground executions for "Proceed While Running". */
	foregroundCommands?: SdkForegroundCommandCoordinator
	/** Resolves once the applicable remote config is ready for a new SDK session. */
	beforeStartSession?: () => Promise<void>
	/** Returns the latest prepared remote-config integration, if remote config is active. */
	getRemoteConfigIntegration?: () => PreparedRemoteConfigCoreIntegration | undefined
	/** Shared SDK telemetry service owned by SdkController. */
	telemetry?: ITelemetryService
	/** Keeps submissions out of Core's queue until a one-turn selection has reverted. */
	deferSend?: (
		sessionId: string,
		prompt: string,
		images?: string[],
		files?: string[],
		delivery?: "queue" | "steer" | "interject",
	) => boolean
	onSendStart?: (sessionId: string, delivery?: "queue" | "steer" | "interject") => void
	onSendComplete: (sessionId: string) => Promise<void> | void
	onSendError: (error: unknown, sessionId: string) => Promise<void> | void
	onHeldSendCancelled?: (sessionId: string, prompt: string, images?: string[], files?: string[]) => void
	/**
	 * Returns (and clears) a pending user-initiated plan/act switch recorded by
	 * SdkModeCoordinator for this session, so fireAndForgetSend — the single
	 * funnel for outbound turn sends — can stamp a <mode_notice> onto the next
	 * message. Consumed exactly once; null when no switch is pending.
	 */
	consumeMcpChangeNotice?: (sessionId: string) => string | undefined
	consumeModeSwitchNotice?: (sessionId: string) => ModeSwitchNotice | null
	onDidBecomeIdle?: () => void
	onSessionReplaced?: (sessionId: string) => void
	onSessionRemoved?: (sessionId: string) => void
	prepareStartInput?: (input: Parameters<VscodeSessionHost["start"]>[0]) => Parameters<VscodeSessionHost["start"]>[0]
}

export class SdkSessionLifecycle {
	private readonly replacements = new Map<string, Promise<string>>()
	private readonly heldSends = new Map<string, Set<() => void>>()
	private readonly replacementHosts = new Set<SdkSessionHost>()
	private activeSession: ActiveSession | undefined
	private focusedSessionId?: string
	private readonly liveSessions = new Map<string, ActiveSession>()
	/** Per-session generations fence completion callbacks from earlier queued turns. */
	private readonly turnGenerations = new Map<string, number>()
	readonly sessionStatuses: Record<string, "running" | "waiting" | "done" | "error"> = {}
	/** Subagent totals per task id, maintained from subagent events for every live session. */
	readonly subagentCounts: Record<string, { total: number; live: number }> = {}
	private sharedHost: SdkSessionHost | undefined
	private sharedHostPromise: Promise<SdkSessionHost> | undefined
	private sharedHostUnsubscribe: (() => void) | undefined
	/**
	 * Stops still in flight, keyed by sessionId. Mode/MCP rebuilds and
	 * follow-up resumes reuse the sessionId of the session they replace, and
	 * core cleanup is keyed by sessionId, so a same-id start that overlaps a
	 * stop would be torn down by the old session's late cleanup.
	 * startNewSession consults this map to enforce stop-before-start, the same
	 * sequencing the CLI uses.
	 */
	private pruningIdleSessions?: Promise<void>
	private readonly pendingStops = new Map<string, Promise<void>>()
	private readonly deletionFences = new Map<string, number>()
	private historyDeletionFences = 0
	private readonly pendingStarts = new Map<string, Set<Promise<unknown>>>()

	/** The caller owns this fence through persistence deletion, including failure recovery. */
	beginTaskDeletion(taskId: string): () => void {
		this.deletionFences.set(taskId, (this.deletionFences.get(taskId) ?? 0) + 1)
		this.cancelHeldSends(taskId)
		let released = false
		return () => {
			if (released) return
			released = true
			const remaining = (this.deletionFences.get(taskId) ?? 1) - 1
			if (remaining) this.deletionFences.set(taskId, remaining)
			else this.deletionFences.delete(taskId)
		}
	}

	/** Fence starts while delete-all enumerates history and processes its selected ids. */
	beginHistoryDeletion(): () => void {
		this.historyDeletionFences++
		for (const taskId of this.heldSends.keys()) this.cancelHeldSends(taskId)
		let released = false
		return () => {
			if (released) return
			released = true
			this.historyDeletionFences--
		}
	}

	async waitForPendingStarts(): Promise<void> {
		await Promise.allSettled([...this.pendingStarts.values()].flatMap((starts) => [...starts]))
	}

	assertTaskAvailable(taskId?: string): void {
		if (this.historyDeletionFences || (taskId && this.deletionFences.has(taskId))) {
			throw new Error("Task is being deleted. Please try again after deletion finishes.")
		}
	}
	constructor(private readonly options: SdkSessionLifecycleOptions) {}

	getActiveSession(): ActiveSession | undefined {
		return this.activeSession
	}

	getSession(taskId: string): ActiveSession | undefined {
		return this.liveSessions.get(taskId)
	}

	focusSession(taskId?: string): void {
		if (taskId) this.assertTaskAvailable(taskId)
		this.focusedSessionId = taskId
		this.activeSession = taskId ? this.liveSessions.get(taskId) : undefined
	}

	getSessions(): ReadonlyMap<string, ActiveSession> {
		return this.liveSessions
	}

	setStatus(taskId: string, status: "running" | "waiting" | "done" | "error"): void {
		this.sessionStatuses[taskId] = status
	}

	/** Records the subagent tally for a task; returns true when it changed. */
	setSubagentCounts(taskId: string, counts: { total: number; live: number }): boolean {
		const current = this.subagentCounts[taskId]
		if (current && current.total === counts.total && current.live === counts.live) {
			return false
		}
		this.subagentCounts[taskId] = counts
		return true
	}

	markSendRunning(taskId = this.activeSession?.sessionId): void {
		if (taskId && !this.replacements.has(taskId)) this.setRunning(true, taskId)
	}

	setRunning(isRunning: boolean, taskId = this.activeSession?.sessionId): void {
		const activeSession = taskId ? this.liveSessions.get(taskId) : undefined
		if (!activeSession || activeSession.isRunning === isRunning) {
			return
		}
		activeSession.isRunning = isRunning
		if (isRunning || this.sessionStatuses[activeSession.sessionId] !== "error")
			this.setStatus(activeSession.sessionId, isRunning ? "running" : "done")
		if (isRunning) {
			this.turnGenerations.set(activeSession.sessionId, (this.turnGenerations.get(activeSession.sessionId) ?? 0) + 1)
		} else {
			this.options.onDidBecomeIdle?.()
			void this.pruneIdleSessions()
		}
	}

	/** Records Core's queue length for the active session; see ActiveSession.queuedPromptCount. */
	setQueuedPromptCount(count: number, taskId = this.activeSession?.sessionId): void {
		const activeSession = taskId ? this.liveSessions.get(taskId) : undefined
		if (!activeSession || activeSession.queuedPromptCount === count) {
			return
		}
		activeSession.queuedPromptCount = count
		if (count === 0 && !activeSession.isRunning) {
			this.options.onDidBecomeIdle?.()
		}
	}

	private clearActiveSessionReference(): ActiveSession | undefined {
		const activeSession = this.activeSession
		this.activeSession = undefined
		this.focusedSessionId = undefined
		return activeSession
	}

	async endActiveSession(
		reason: string,
		options: { awaitStop?: boolean; timeoutMs?: number } = {},
	): Promise<ActiveSession | undefined> {
		const activeSession = this.clearActiveSessionReference()
		if (!activeSession) {
			return undefined
		}
		this.cancelHeldSends(activeSession.sessionId)

		this.liveSessions.delete(activeSession.sessionId)
		this.turnGenerations.delete(activeSession.sessionId)
		this.safeUnsubscribe(activeSession, reason)
		const stopPromise = this.trackSessionStop(activeSession.sdkHost, activeSession.sessionId, reason)
		if (options.awaitStop) {
			const timeoutMs = options.timeoutMs ?? 3000
			const stopped = await this.waitForStop(stopPromise, timeoutMs)
			if (!stopped) {
				Logger.warn(
					`[SdkController] Timed out stopping SDK session ${activeSession.sessionId} after ${timeoutMs}ms (${reason})`,
				)
			}
		}
		return activeSession
	}

	/**
	 * Resolves once any in-flight stop for `sessionId` has settled. Callers that
	 * start a session outside startNewSession (e.g. on an isolated host) must
	 * wait here first, or the old session's late cleanup tears down the new one.
	 */
	async waitForPendingStop(sessionId: string): Promise<void> {
		const pendingStop = this.pendingStops.get(sessionId)
		if (pendingStop) {
			Logger.log(`[SdkController] Waiting for session ${sessionId} to stop before restarting it`)
			await pendingStop
		}
	}

	async updateActiveSessionModel(modelId: string): Promise<boolean> {
		const activeSession = this.activeSession
		if (!activeSession?.sdkHost.updateSessionModel) {
			return false
		}

		await activeSession.sdkHost.updateSessionModel(activeSession.sessionId, modelId)
		if (activeSession.startConfig) activeSession.startConfig.modelId = modelId
		return true
	}

	async startNewSession(
		startInput: Parameters<VscodeSessionHost["start"]>[0],
		options?: { focus?: boolean },
	): Promise<{ startResult: StartSessionResult; sdkHost: SdkSessionHost }> {
		const id = startInput.config?.sessionId?.trim()
		this.assertTaskAvailable(id)
		const starting = this.performStartNewSession(startInput, options)
		const key = id ?? ""
		const starts = this.pendingStarts.get(key) ?? new Set<Promise<unknown>>()
		starts.add(starting)
		this.pendingStarts.set(key, starts)
		try {
			return await starting
		} finally {
			starts.delete(starting)
			if (!starts.size) this.pendingStarts.delete(key)
		}
	}

	private async performStartNewSession(
		startInput: Parameters<VscodeSessionHost["start"]>[0],
		options?: { focus?: boolean },
	): Promise<{ startResult: StartSessionResult; sdkHost: SdkSessionHost }> {
		startInput = this.options.prepareStartInput?.(startInput) ?? startInput
		// A new task leaves other tasks alive. Only a same-id replacement stops first.
		const replacementId = startInput.config?.sessionId?.trim()
		if (replacementId && this.liveSessions.has(replacementId)) {
			this.focusSession(replacementId)
			await this.endActiveSession("startNewSession")
		}

		// Same-id starts must wait for the previous session's stop to finish;
		// see pendingStops. A fresh id cannot conflict, so it never waits.
		const requestedSessionId = startInput.config?.sessionId?.trim()
		if (requestedSessionId) {
			await this.waitForPendingStop(requestedSessionId)
		}

		const autoApprovalSettings = StateManager.get().getGlobalSettingsKey("autoApprovalSettings")
		const toolPolicies = autoApprovalSettings ? buildToolPolicies(autoApprovalSettings, this.options.mcpHub) : undefined

		const sdkHost = await this.getOrCreateSharedHost()

		this.assertTaskAvailable(requestedSessionId)
		const focusedIdAtStart = this.focusedSessionId
		const startResult = await sdkHost.start({
			...startInput,
			...(toolPolicies ? { toolPolicies } : {}),
		})
		this.activeSession = {
			sessionId: startResult.sessionId,
			apiSnapshot: getSessionApiSnapshot(startInput.config),
			startConfig: startInput.config
				? {
						providerId: startInput.config.providerId,
						modelId: startInput.config.modelId,
						mode: startInput.mode === "plan" ? "plan" : "act",
					}
				: undefined,
			sdkHost,
			unsubscribe: () => {},
			startResult,
			isRunning: true,
			queuedPromptCount: 0,
		}

		this.liveSessions.set(startResult.sessionId, this.activeSession)
		this.setStatus(startResult.sessionId, "running")
		// Register first so deletion can stop a start that crossed an awaited host.start.
		this.assertTaskAvailable(startResult.sessionId)
		// A background (focus:false) start leaves whatever the user was looking at —
		// including the inbox — focused; the new chat runs without being shown.
		this.focusSession(
			options?.focus === false
				? (this.focusedSessionId ?? focusedIdAtStart)
				: (this.focusedSessionId ?? focusedIdAtStart ?? startResult.sessionId),
		)
		await this.pruneIdleSessions()
		return { startResult, sdkHost }
	}

	async replaceActiveSession(options: {
		expectedSession: ActiveSession
		startInput: Parameters<VscodeSessionHost["start"]>[0]
		initialMessages?: Parameters<VscodeSessionHost["start"]>[0]["initialMessages"]
		disposeReason: string
		loadInitialMessages?: () => Promise<Parameters<VscodeSessionHost["start"]>[0]["initialMessages"]>
		onReplaced?: (sessionId: string) => Promise<void> | void
	}): Promise<
		| {
				oldSessionId: string
				startResult: StartSessionResult
				sdkHost: SdkSessionHost
		  }
		| undefined
	> {
		const oldSession = this.activeSession
		if (!oldSession || oldSession !== options.expectedSession || oldSession.isRunning) {
			return undefined
		}

		return this.replaceSession(options)
	}

	/** Replace an idle retained session without moving the user's focus. */
	async replaceSession(options: Parameters<SdkSessionLifecycle["replaceActiveSession"]>[0]) {
		const old = options.expectedSession
		const generation = this.turnGenerations.get(old.sessionId)
		if (this.replacements.has(old.sessionId)) return undefined
		this.assertTaskAvailable(old.sessionId)
		if (this.liveSessions.get(old.sessionId) !== old || old.isRunning || old.queuedPromptCount > 0) return undefined
		// Close admission synchronously, before reading history or creating a host.
		let release!: (sessionId: string) => void
		let liveId = old.sessionId
		const barrier = new Promise<string>((resolve) => {
			release = resolve
		})
		this.replacements.set(old.sessionId, barrier)
		let sdkHost: SdkSessionHost | undefined
		let installed = false
		try {
			const input = this.options.prepareStartInput?.(options.startInput) ?? options.startInput
			const initialMessages = options.loadInitialMessages ? await options.loadInitialMessages() : options.initialMessages
			sdkHost = await this.createHost()
			const idle = () =>
				this.liveSessions.get(old.sessionId) === old &&
				this.turnGenerations.get(old.sessionId) === generation &&
				!old.isRunning &&
				old.queuedPromptCount === 0
			if (!idle()) return undefined
			const approval = StateManager.get().getGlobalSettingsKey("autoApprovalSettings")
			const toolPolicies = approval ? buildToolPolicies(approval, this.options.mcpHub) : undefined
			this.assertTaskAvailable(old.sessionId)
			const startResult = await sdkHost.start({
				...input,
				...(toolPolicies ? { toolPolicies } : {}),
				...(initialMessages ? { initialMessages } : {}),
			})
			// Core can drain a previously queued prompt without an extension send.
			// Keep the old runtime if a turn entered while the new host started.
			if (!idle()) return undefined
			this.assertTaskAvailable(old.sessionId)
			const replacement: ActiveSession = {
				...old,
				sessionId: startResult.sessionId,
				sdkHost,
				startResult,
				apiSnapshot: getSessionApiSnapshot(input.config),
				startConfig: input.config
					? {
							providerId: input.config.providerId,
							modelId: input.config.modelId,
							mode: input.mode === "plan" ? "plan" : "act",
						}
					: undefined,
				unsubscribe: this.createSafeUnsubscribe(
					sdkHost.subscribe((event) => {
						const current = this.liveSessions.get(event.payload.sessionId)
						if (!current || current.sdkHost === sdkHost) this.options.onSessionEvent(event)
					}),
					"replacement",
				),
				isRunning: false,
				queuedPromptCount: 0,
			}
			this.liveSessions.delete(old.sessionId)
			this.liveSessions.set(startResult.sessionId, replacement)
			this.replacementHosts.add(sdkHost)
			liveId = startResult.sessionId
			installed = true
			this.setStatus(startResult.sessionId, "done")
			if (this.focusedSessionId === old.sessionId) this.focusSession(startResult.sessionId)
			this.safeUnsubscribe(old, options.disposeReason)
			try {
				this.options.onSessionReplaced?.(old.sessionId)
				await options.onReplaced?.(startResult.sessionId)
			} finally {
				await this.trackSessionStop(old.sdkHost, old.sessionId, options.disposeReason)
			}
			return { oldSessionId: old.sessionId, startResult, sdkHost }
		} finally {
			if (sdkHost && !installed)
				await sdkHost
					.dispose("replacement abandoned")
					.catch((error) => Logger.warn("[SdkController] Failed to dispose replacement", error))
			this.replacements.delete(old.sessionId)
			release(liveId)
		}
	}

	async waitForReplacement(sessionId: string): Promise<string> {
		while (this.replacements.has(sessionId)) sessionId = await this.replacements.get(sessionId)!
		return sessionId
	}

	async restoreActiveSession(input: RestoreInput): Promise<RestoreResult> {
		const activeSession = this.activeSession
		if (!activeSession) {
			throw new Error("No active SDK session to restore")
		}

		const sourceSessionId = activeSession.sessionId
		const restored = await activeSession.sdkHost.restore(input)
		if (!restored.startResult || !restored.sessionId) {
			return restored
		}

		this.activeSession = {
			...activeSession,
			sessionId: restored.sessionId,
			apiSnapshot: input.start?.config ? getSessionApiSnapshot(input.start.config) : activeSession.apiSnapshot,
			startConfig: input.start?.config
				? {
						providerId: input.start.config.providerId,
						modelId: input.start.config.modelId,
						mode:
							input.start.mode === "plan" || input.start.mode === "act"
								? input.start.mode
								: activeSession.startConfig?.mode,
					}
				: activeSession.startConfig,
			startResult: restored.startResult,
			isRunning: false,
			queuedPromptCount: 0,
		}

		this.liveSessions.set(restored.sessionId, this.activeSession)
		if (restored.sessionId !== sourceSessionId) {
			this.liveSessions.delete(sourceSessionId)
			const stopPromise = this.trackSessionStop(activeSession.sdkHost, sourceSessionId, "restoreActiveSession")
			stopPromise.catch((error) => {
				Logger.warn(`[SdkController] Failed to stop source session after checkpoint restore: ${sourceSessionId}`, error)
			})
		}

		return restored
	}

	async dispose(reason = "SdkSessionLifecycle.dispose"): Promise<void> {
		for (const taskId of this.heldSends.keys()) this.cancelHeldSends(taskId)
		await Promise.allSettled([...this.replacements.values()])
		await Promise.all(
			[...this.liveSessions.values()].map((session) => this.trackSessionStop(session.sdkHost, session.sessionId, reason)),
		)
		this.liveSessions.clear()
		this.turnGenerations.clear()
		this.activeSession = undefined

		await Promise.all([...this.replacementHosts].map((host) => host.dispose(reason)))
		this.replacementHosts.clear()
		const sharedHost = this.sharedHost ?? (await this.sharedHostPromise?.catch(() => undefined))
		this.sharedHost = undefined
		this.sharedHostPromise = undefined
		this.sharedHostUnsubscribe?.()
		this.sharedHostUnsubscribe = undefined
		await sharedHost?.dispose(reason)
	}

	/** Stop a task by id, including background tasks, before deleting its persistence. */
	async removeSession(taskId: string): Promise<void> {
		const release = this.beginTaskDeletion(taskId)
		try {
			await this.waitForReplacement(taskId)
			await Promise.allSettled([...(this.pendingStarts.get(taskId) ?? [])])
			const session = this.liveSessions.get(taskId)
			if (session) {
				this.liveSessions.delete(taskId)
				this.turnGenerations.delete(taskId)
				if (this.activeSession === session) this.activeSession = undefined
				this.safeUnsubscribe(session, "task deleted")
				try {
					await this.trackSessionStop(session.sdkHost, taskId, "task deleted", true)
				} catch (error) {
					// Keep the handle available for a retry; persistence must survive a failed stop.
					if (!this.liveSessions.has(taskId)) this.liveSessions.set(taskId, session)
					if (this.focusedSessionId === taskId) this.activeSession = session
					throw error
				}
			} else {
				await this.waitForPendingStop(taskId)
			}
			delete this.sessionStatuses[taskId]
			delete this.subagentCounts[taskId]
			this.options.onSessionRemoved?.(taskId)
		} finally {
			release()
		}
	}

	/** Retain at most eight idle handles. Re-evaluate after every asynchronous stop. */
	private pruneIdleSessions(): Promise<void> {
		if (this.pruningIdleSessions) return this.pruningIdleSessions
		const prune = this.performIdlePrune().finally(() => {
			if (this.pruningIdleSessions === prune) this.pruningIdleSessions = undefined
		})
		this.pruningIdleSessions = prune
		return prune
	}

	private async performIdlePrune(): Promise<void> {
		const eligible = (session: ActiveSession) =>
			this.liveSessions.get(session.sessionId) === session &&
			this.focusedSessionId !== session.sessionId &&
			this.activeSession !== session &&
			!session.isRunning &&
			!this.replacements.has(session.sessionId) &&
			!session.queuedPromptCount &&
			this.sessionStatuses[session.sessionId] !== "waiting"
		while (true) {
			const idle = [...this.liveSessions.values()].filter(eligible)
			if (idle.length <= 8) return
			const session = idle[0]
			if (!eligible(session)) continue
			// Remove the exact handle synchronously with the eligibility check.
			this.liveSessions.delete(session.sessionId)
			this.turnGenerations.delete(session.sessionId)
			this.safeUnsubscribe(session, "idle session limit")
			this.options.onSessionRemoved?.(session.sessionId)
			await this.trackSessionStop(session.sdkHost, session.sessionId, "idle session limit")
		}
	}

	private createSafeUnsubscribe(unsubscribe: () => void, label: string): () => void {
		let unsubscribed = false
		return () => {
			if (unsubscribed) {
				return
			}
			unsubscribed = true
			try {
				unsubscribe()
			} catch (error) {
				Logger.warn(`[SdkController] Failed to unsubscribe SDK session listener (${label}):`, error)
			}
		}
	}

	private safeUnsubscribe(activeSession: ActiveSession, reason: string): void {
		activeSession.unsubscribe()
		Logger.debug(`[SdkController] Unsubscribed SDK session listener: ${activeSession.sessionId} (${reason})`)
	}

	private ensureSharedHostSubscription(sdkHost: SdkSessionHost): void {
		if (this.sharedHostUnsubscribe) {
			return
		}
		this.sharedHostUnsubscribe = this.createSafeUnsubscribe(
			sdkHost.subscribe((event) => {
				const current = this.liveSessions.get(event.payload.sessionId)
				if (!current || current.sdkHost === sdkHost) this.options.onSessionEvent(event)
			}),
			"shared-host",
		)
	}

	/**
	 * Starts the session's stop and records it in pendingStops until it
	 * settles. The returned promise never rejects.
	 */
	private trackSessionStop(sdkHost: SdkSessionHost, sessionId: string, reason: string, propagateError = false): Promise<void> {
		const startedAt = Date.now()
		const stopPromise = sdkHost
			.stop(sessionId)
			.then(async () => {
				if (
					this.replacementHosts.has(sdkHost) &&
					![...this.liveSessions.values()].some((session) => session.sdkHost === sdkHost)
				) {
					this.replacementHosts.delete(sdkHost)
					await sdkHost
						.dispose(reason)
						.catch((error) => Logger.warn("[SdkController] Failed to dispose unused replacement host", error))
				}
				const elapsed = Date.now() - startedAt
				if (elapsed > 250) {
					Logger.log(`[SdkController] SDK session ${sessionId} stopped in ${elapsed}ms (${reason})`)
				}
			})
			.catch((error: unknown) => {
				Logger.warn(`[SdkController] Failed to stop SDK session ${sessionId} (${reason}):`, error)
				if (propagateError) throw error
			})
			.finally(() => {
				if (this.pendingStops.get(sessionId) === stopPromise) {
					this.pendingStops.delete(sessionId)
				}
			})
		this.pendingStops.set(sessionId, stopPromise)
		return stopPromise
	}

	private async waitForStop(stopPromise: Promise<void>, timeoutMs: number): Promise<boolean> {
		let timeoutHandle: ReturnType<typeof setTimeout> | undefined
		try {
			const timeout = new Promise<"timeout">((resolve) => {
				timeoutHandle = setTimeout(() => resolve("timeout"), timeoutMs)
			})
			const result = await Promise.race([stopPromise.then(() => "stopped" as const), timeout])
			return result === "stopped"
		} finally {
			clearTimeout(timeoutHandle)
		}
	}

	private createHost(): Promise<SdkSessionHost> {
		return VscodeSessionHost.create({
			mcpHub: this.options.mcpHub,
			requestToolApproval: this.options.requestToolApproval,
			askQuestion: this.options.askQuestion,
			editorExecutor: this.options.editorExecutor,
			applyPatchExecutor: this.options.applyPatchExecutor,
			readFileExecutor: this.options.readFileExecutor,
			getTerminalManager: this.options.getTerminalManager,
			foregroundCommands: this.options.foregroundCommands,
			beforeStartSession: this.options.beforeStartSession,
			getRemoteConfigIntegration: this.options.getRemoteConfigIntegration,
			telemetry: this.options.telemetry,
		})
	}

	private async getOrCreateSharedHost(): Promise<SdkSessionHost> {
		if (this.sharedHost) {
			this.ensureSharedHostSubscription(this.sharedHost)
			return this.sharedHost
		}
		if (!this.sharedHostPromise) {
			// Host-lifetime dependencies only. Anything task/session-specific must be
			// supplied to sdkHost.start(...), otherwise it can leak across reused sessions.
			this.sharedHostPromise = this.createHost()
				.then((sdkHost) => {
					this.ensureSharedHostSubscription(sdkHost)
					this.sharedHost = sdkHost
					return sdkHost
				})
				.finally(() => {
					this.sharedHostPromise = undefined
				})
		}
		return this.sharedHostPromise
	}

	/** Drop admission-held submissions before aborting, and fence an uninstalled swap. */
	cancelHeldSends(sessionId: string): void {
		this.turnGenerations.set(sessionId, (this.turnGenerations.get(sessionId) ?? 0) + 1)
		const held = this.heldSends.get(sessionId)
		this.heldSends.delete(sessionId)
		for (const cancel of held ?? []) cancel()
	}

	fireAndForgetSend(
		sdkHost: SdkSessionHost,
		sessionId: string,
		prompt: string,
		images?: string[],
		files?: string[],
		delivery?: "queue" | "steer" | "interject",
	): void {
		this.assertTaskAvailable(sessionId)
		const racedLive = this.liveSessions.get(sessionId)
		if (this.replacements.has(sessionId) && delivery === "interject" && racedLive?.isRunning) {
			// A turn raced into the old runtime during replacement start, so the
			// replacement's generation check will reject the swap. Deliver the
			// interject to that runtime through Core's own interject path, which
			// aborts the turn immediately while preserving the pending queue.
			sdkHost = racedLive.sdkHost
		} else if (this.replacements.has(sessionId)) {
			const held = this.heldSends.get(sessionId) ?? new Set<() => void>()
			this.heldSends.set(sessionId, held)
			let cancelled = false
			const cancellation = Promise.withResolvers<never>()
			const cancel = () => {
				cancelled = true
				const error = new Error("Held submission aborted")
				error.name = "AbortError"
				cancellation.reject(error)
				this.options.onHeldSendCancelled?.(sessionId, prompt, images, files)
			}
			held.add(cancel)
			void Promise.race([Promise.all([this.waitForReplacement(sessionId)]), cancellation.promise])
				.then(([liveId]) => {
					if (cancelled) return
					held.delete(cancel)
					const live = this.liveSessions.get(liveId)
					if (!live) throw new Error("Session ended during replacement")
					this.fireAndForgetSend(live.sdkHost, live.sessionId, prompt, images, files, delivery)
				})
				.catch((error) => {
					if (!isAbortError(error)) return this.options.onSendError(error, sessionId)
				})
				.finally(() => {
					held.delete(cancel)
					if (!held.size && this.heldSends.get(sessionId) === held) this.heldSends.delete(sessionId)
				})
			return
		}
		sdkHost = this.liveSessions.get(sessionId)?.sdkHost ?? sdkHost
		if (this.options.deferSend?.(sessionId, prompt, images, files, delivery)) return
		// Captured by object identity, not sessionId: rebuilds (mode change) reuse
		// the same sessionId for the replacement session, so only reference
		// equality can tell this send's session apart from a successor. If the
		// session was replaced by the time the send settles, the settle callbacks
		// must not run bookkeeping against the successor (e.g. flipping a live
		// auto-continued run to isRunning=false, which makes the event coordinator
		// treat the new turn's completion as a cancelled-turn straggler). The
		// same applies within one session when Core drains a queued prompt into
		// a new turn before this send's promise settles.
		this.setRunning(true, sessionId)
		const sessionAtSend = this.liveSessions.get(sessionId)
		const turnAtSend = this.turnGenerations.get(sessionId)
		const isSuperseded = (label: string): boolean => {
			if (this.liveSessions.get(sessionId) === sessionAtSend && this.turnGenerations.get(sessionId) === turnAtSend) {
				return false
			}
			Logger.debug(`[SdkController] Ignoring ${label} of superseded send for session: ${sessionId}`)
			return true
		}
		// Mark a preceding user-initiated mode switch on this message so the model
		// sees exactly when the rules changed, instead of only inferring it from
		// the user_input mode attribute flipping (mirrors the CLI's
		// run-interactive stamping). The notice survives prepareTurnInput's
		// normalizeUserInput sanitize and is hidden from display surfaces by
		// stripModeNotices.
		const notice = this.options.consumeModeSwitchNotice?.(sessionId)
		const mcpNotice = this.options.consumeMcpChangeNotice?.(sessionId)
		const noticedPrompt = [mcpNotice, notice ? formatModeSwitchNotice(notice.from, notice.to) : undefined, prompt]
			.filter(Boolean)
			.join("\n")
		this.options.onSendStart?.(sessionId, delivery)
		sdkHost
			.send({
				sessionId,
				prompt: noticedPrompt,
				userImages: images,
				userFiles: files,
				delivery,
			})
			.then(async () => {
				if (delivery === "queue" || delivery === "steer" || delivery === "interject") {
					Logger.log(`[SdkController] Message queued for session: ${sessionId}`)
					return
				}
				if (isSuperseded("completion")) {
					return
				}
				Logger.log(`[SdkController] Agent turn completed for session: ${sessionId}`)
				this.setRunning(false, sessionId)
				await this.options.onSendComplete(sessionId)
			})
			.catch(async (error: unknown) => {
				if (isAbortError(error)) {
					Logger.debug(`[SdkController] Agent turn aborted (expected): ${sessionId}`)
					return
				}
				if (isSuperseded("failure")) {
					return
				}
				Logger.error("[SdkController] Agent turn failed:", error)
				this.setRunning(false, sessionId)
				this.setStatus(sessionId, "error")
				await this.options.onSendError(error, sessionId)
			})
	}
}

export function isAbortError(error: unknown): boolean {
	if (error instanceof Error) {
		return error.name === "AbortError" || error.message.toLowerCase().includes("aborted")
	}
	return false
}
