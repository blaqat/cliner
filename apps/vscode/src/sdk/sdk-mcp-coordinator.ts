import type { ClineMessage } from "@shared/ExtensionMessage"
import type { Mode } from "@shared/storage/types"
import type { StateManager } from "@/core/storage/StateManager"
import { Logger } from "@/shared/services/Logger"
import type { SdkMessageCoordinator } from "./sdk-message-coordinator"
import type { SdkSessionConfigBuilder } from "./sdk-session-config-builder"
import type { SdkSessionLifecycle } from "./sdk-session-lifecycle"
import type { SdkSessionRebuildScheduler } from "./sdk-session-rebuild-scheduler"
import type { SdkSessionHost } from "./session-host"
import type { VscodeSessionHost } from "./vscode-session-host"

type StartInput = Parameters<VscodeSessionHost["start"]>[0]
type InitialMessages = StartInput["initialMessages"]
type SessionConfig = Awaited<ReturnType<SdkSessionConfigBuilder["build"]>>

export interface SdkMcpCoordinatorOptions {
	stateManager: StateManager
	sessions: SdkSessionLifecycle
	messages: SdkMessageCoordinator
	sessionConfigBuilder: SdkSessionConfigBuilder
	getWorkspaceRoot: () => Promise<string>
	loadInitialMessages: (sdkHost: SdkSessionHost, sessionId: string) => Promise<unknown[] | undefined>
	buildStartSessionInput: (config: SessionConfig, input: { cwd: string; mode: Mode }) => StartInput
	postStateToWebview: () => Promise<void>
	getMessages?: (sessionId: string) => SdkMessageCoordinator
	getToolSnapshot?: () => Record<string, string[]>
	rebuilds: Pick<SdkSessionRebuildScheduler, "request">
}

export class SdkMcpCoordinator {
	private readonly pendingSessions = new Set<string>()
	private readonly warnedSessions = new Set<string>()
	private idleBoundary = 0
	private readonly scheduledSessions = new Set<string>()
	private readonly notices = new Map<string, string>()

	private snapshot: Record<string, string[]>
	private readonly changeDescriptions = new Map<string, Set<string>>()

	constructor(private readonly options: SdkMcpCoordinatorOptions) {
		this.snapshot = options.getToolSnapshot?.() ?? {}
	}

	handleToolListChanged(): void {
		Logger.log("[SdkController] MCP tool list changed")

		const next = this.options.getToolSnapshot?.() ?? {}
		const changes: string[] = []
		for (const [name, tools] of Object.entries(next)) {
			if (!(name in this.snapshot)) changes.push(`added server ${name} (tools ${tools.join(", ") || "none"})`)
			else if (JSON.stringify(tools) !== JSON.stringify(this.snapshot[name]))
				changes.push(`updated server ${name} (tools ${tools.join(", ") || "none"})`)
		}
		for (const name of Object.keys(this.snapshot)) if (!(name in next)) changes.push(`removed server ${name}`)
		this.snapshot = next
		if (!changes.length) changes.push("server connections or tool definitions updated")
		const sessions =
			this.options.sessions.getSessions?.().values() ??
			[this.options.sessions.getActiveSession()].filter((session) => session !== undefined)
		for (const session of sessions) {
			this.pendingSessions.add(session.sessionId)
			const descriptions = this.changeDescriptions.get(session.sessionId) ?? new Set<string>()
			for (const change of changes) descriptions.add(change)
			this.changeDescriptions.set(session.sessionId, descriptions)
			this.schedule(session.sessionId)
		}
	}

	forgetSession(sessionId: string): void {
		this.warnedSessions.delete(sessionId)
		this.scheduledSessions.delete(sessionId)
		this.pendingSessions.delete(sessionId)
		this.notices.delete(sessionId)
		this.changeDescriptions.delete(sessionId)
	}

	consumeMcpChangeNotice(sessionId: string): string | undefined {
		const notice = this.notices.get(sessionId)
		this.notices.delete(sessionId)
		return notice
	}

	sessionBecameIdle(): void {
		this.idleBoundary++
		for (const id of this.pendingSessions) if (!this.scheduledSessions.has(id)) this.schedule(id)
	}

	private schedule(id: string): void {
		this.scheduledSessions.add(id)
		this.options.rebuilds.request(
			"mcpTools",
			async (context) => {
				const boundary = this.idleBoundary
				try {
					await this.restartSessionForMcpTools(id, context.isCurrent)
				} finally {
					if (context.isCurrent()) {
						this.scheduledSessions.delete(id)
						// A fast failed send can finish while failure reporting is still in flight.
						// Preserve that later boundary without retrying the same failure in a loop.
						if (this.pendingSessions.has(id) && this.idleBoundary > boundary) this.schedule(id)
					}
				}
			},
			id,
		)
	}

	async restartSessionForMcpTools(sessionId?: string, isCurrent: () => boolean = () => true): Promise<void> {
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

		const messages = this.options.getMessages?.(oldSessionId) ?? this.options.messages
		Logger.log(`[SdkController] Restarting session ${oldSessionId} for MCP tool changes`)
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
							apiConfiguration: activeSession.apiSnapshot.configuration,
							apiSelection: activeSession.apiSnapshot.selection,
						}
					: {}),
			})
			config.sessionId = oldSessionId

			const startInput = this.options.buildStartSessionInput(config, { cwd, mode })
			const replace =
				this.options.sessions.replaceSession?.bind(this.options.sessions) ??
				this.options.sessions.replaceActiveSession.bind(this.options.sessions)
			if (!isCurrent()) return
			const changes = new Set(this.changeDescriptions.get(oldSessionId))
			const restartResult = await replace({
				expectedSession: activeSession,
				startInput,
				loadInitialMessages: async () =>
					(await this.options.loadInitialMessages(oldManager, oldSessionId)) as InitialMessages,
				disposeReason: "mcpToolRestart",
				onReplaced: (replacementId) => {
					const descriptions = [...changes].join("; ").slice(0, 2000).replaceAll("<", "&lt;").replaceAll(">", "&gt;")
					const previous = this.notices.get(oldSessionId)
					this.notices.set(
						replacementId,
						`${previous ? `${previous}\n` : ""}<mcp_notice>MCP tools changed: ${descriptions || "server connections or tool definitions updated"}.</mcp_notice>`,
					)
				},
			})
			if (!restartResult) {
				if (isCurrent() && this.options.sessions.getSession?.(oldSessionId) === activeSession) this.schedule(oldSessionId)
				return
			}
			const { startResult } = restartResult
			if (isCurrent()) {
				this.pendingSessions.delete(oldSessionId)
				this.changeDescriptions.delete(oldSessionId)
				this.warnedSessions.delete(oldSessionId)
			}

			if (startResult.sessionId !== oldSessionId) {
				Logger.warn(
					`[SdkController] MCP tool restart returned a new session ID (${startResult.sessionId}); preserving task ID ${oldSessionId} for UI continuity`,
				)
			}

			// Silently return the session to idle — no "reloaded successfully"
			// chat message or completion banner. The reload is transparent.
			messages.emitSessionEvents([], {
				type: "status",
				payload: { sessionId: startResult.sessionId, status: "idle" },
			})

			await this.options.postStateToWebview()
			Logger.log(`[SdkController] Session restarted for MCP tools: ${oldSessionId} -> ${startResult.sessionId}`)
		} catch (error) {
			Logger.error("[SdkController] Failed to restart session for MCP tools:", error)

			if (this.warnedSessions.has(oldSessionId)) return
			this.warnedSessions.add(oldSessionId)
			const errorMessage: ClineMessage = {
				ts: Date.now(),
				type: "say",
				say: "error",
				text: `Failed to reload MCP tools: ${error instanceof Error ? error.message : String(error)}. MCP tools may be outdated.`,
				partial: false,
			}
			messages.appendAndEmit([errorMessage], {
				type: "status",
				payload: { sessionId: oldSessionId, status: "idle" },
			})
			await this.options.postStateToWebview()
		}
	}
}
