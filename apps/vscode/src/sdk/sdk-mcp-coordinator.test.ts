import { beforeEach, describe, expect, it, vi } from "vitest"
import type { StateManager } from "@/core/storage/StateManager"
import { SdkMcpCoordinator, type SdkMcpCoordinatorOptions } from "./sdk-mcp-coordinator"
import { SdkSessionRebuildScheduler } from "./sdk-session-rebuild-scheduler"

vi.mock("@/shared/services/Logger", () => ({
	Logger: {
		error: vi.fn(),
		log: vi.fn(),
		warn: vi.fn(),
	},
}))

describe("SdkMcpCoordinator", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("does nothing when MCP tools change without an active session", () => {
		const { coordinator, options } = makeCoordinator()

		coordinator.handleToolListChanged()

		expect(options.sessions.replaceActiveSession).not.toHaveBeenCalled()
	})

	it("schedules MCP restart while the active session is running", () => {
		const activeSession = makeActiveSession({ isRunning: true })
		const { coordinator, options } = makeCoordinator({ activeSession })

		coordinator.handleToolListChanged()

		expect(options.sessions.replaceActiveSession).not.toHaveBeenCalled()
		expect(options.rebuilds.request).toHaveBeenCalledWith("mcpTools", expect.any(Function), "old-session")
	})

	it("restarts immediately when MCP tools change while the active session is idle", async () => {
		const activeSession = makeActiveSession()
		const { coordinator, options } = makeCoordinator({ activeSession })

		coordinator.handleToolListChanged()

		await vi.waitFor(() => expect(options.sessions.replaceActiveSession).toHaveBeenCalledOnce())
		// Reloading tools is silent: only a status transition is emitted, no chat message.
		expect(options.messages.emitSessionEvents).toHaveBeenCalledWith([], {
			type: "status",
			payload: { sessionId: "old-session", status: "running" },
		})
		expect(options.messages.appendAndEmit).not.toHaveBeenCalled()
	})

	it("rebuilds the active session with the current mode and preserved messages", async () => {
		const activeSession = makeActiveSession()
		const { coordinator, options } = makeCoordinator({ activeSession, mode: "plan" })

		await coordinator.restartSessionForMcpTools()

		expect(options.sessionConfigBuilder.build).toHaveBeenCalledWith({ cwd: "/workspace", mode: "plan" })
		expect(options.loadInitialMessages).toHaveBeenCalledWith(activeSession.sdkHost, "old-session")
		expect(options.buildStartSessionInput).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "old-session" }), {
			cwd: "/workspace",
			mode: "plan",
		})
		expect(options.sessions.replaceActiveSession).toHaveBeenCalledWith({
			expectedSession: activeSession,
			startInput: { prompt: "start" },
			loadInitialMessages: expect.any(Function),
			disposeReason: "mcpToolRestart",
			onReplaced: expect.any(Function),
		})
		// Success is silent: only a status transition back to idle, no chat
		// message or completion banner.
		expect(options.messages.emitSessionEvents).toHaveBeenCalledWith([], {
			type: "status",
			payload: { sessionId: "new-session", status: "idle" },
		})
		expect(options.messages.appendAndEmit).not.toHaveBeenCalled()
		expect(options.postStateToWebview).toHaveBeenCalledOnce()
	})

	it("fans out to retained sessions and consumes each rebuild notice once", async () => {
		const a = makeActiveSession()
		const b = { ...makeActiveSession({ isRunning: true }), sessionId: "background" }
		const { coordinator, options } = makeCoordinator({ activeSession: a })
		options.sessions.getSessions = () =>
			new Map([
				[a.sessionId, a],
				[b.sessionId, b],
			]) as never
		options.sessions.getSession = (id) => (id === a.sessionId ? a : b) as never
		options.rebuilds.request = vi.fn()
		coordinator.handleToolListChanged()
		expect(options.rebuilds.request).toHaveBeenCalledWith("mcpTools", expect.any(Function), "background")
		await coordinator.restartSessionForMcpTools("background")
		expect(options.sessions.replaceActiveSession).toHaveBeenCalledWith(expect.objectContaining({ expectedSession: b }))
		expect(coordinator.consumeMcpChangeNotice("new-session")).toContain("MCP tools changed")
		expect(coordinator.consumeMcpChangeNotice("new-session")).toBeUndefined()
	})

	it("rebuilds focused and background sessions only once their queues are idle", async () => {
		const a = { ...makeActiveSession({ isRunning: true }), queuedPromptCount: 1 }
		const b = { ...makeActiveSession({ isRunning: true }), sessionId: "background", queuedPromptCount: 0 }
		const { coordinator, options } = makeCoordinator({ activeSession: a })
		options.sessions.getSessions = () =>
			new Map([
				[a.sessionId, a],
				[b.sessionId, b],
			]) as never
		options.sessions.getSession = (id) => (id === a.sessionId ? a : b) as never
		const scheduler = new SdkSessionRebuildScheduler({ sessions: options.sessions })
		options.rebuilds = scheduler
		coordinator.handleToolListChanged()
		scheduler.sessionBecameIdle()
		expect(options.sessions.replaceActiveSession).not.toHaveBeenCalled()
		b.isRunning = false
		scheduler.sessionBecameIdle()
		await vi.waitFor(() => expect(options.sessions.replaceActiveSession).toHaveBeenCalledTimes(1))
		a.isRunning = false
		scheduler.sessionBecameIdle()
		expect(options.sessions.replaceActiveSession).toHaveBeenCalledTimes(1)
		a.queuedPromptCount = 0
		scheduler.sessionBecameIdle()
		await vi.waitFor(() => expect(options.sessions.replaceActiveSession).toHaveBeenCalledTimes(2))
	})

	it.each([false, true])("retries at the next idle boundary and warns once, persistent=%s", async (persistent) => {
		const a = { ...makeActiveSession(), queuedPromptCount: 0 }
		const { coordinator, options } = makeCoordinator({ activeSession: a })
		options.sessions.getSession = () => a as never
		const scheduler = new SdkSessionRebuildScheduler({ sessions: options.sessions })
		options.rebuilds = scheduler
		if (persistent) options.sessionConfigBuilder.build.mockRejectedValue(new Error("failure"))
		else options.sessionConfigBuilder.build.mockRejectedValueOnce(new Error("failure"))
		coordinator.handleToolListChanged()
		await vi.waitFor(() => expect(options.messages.appendAndEmit).toHaveBeenCalledTimes(1))
		coordinator.sessionBecameIdle()
		scheduler.sessionBecameIdle()
		await vi.waitFor(() => expect(options.sessionConfigBuilder.build).toHaveBeenCalledTimes(2))
		expect(options.messages.appendAndEmit).toHaveBeenCalledTimes(1)
		if (!persistent)
			await vi.waitFor(() => expect(coordinator.consumeMcpChangeNotice("new-session")).toContain("MCP tools changed"))
	})

	it("preserves an idle boundary reached while a failed rebuild is still reporting", async () => {
		const a = { ...makeActiveSession(), queuedPromptCount: 0 }
		const { coordinator, options } = makeCoordinator({ activeSession: a })
		const scheduler = new SdkSessionRebuildScheduler({ sessions: options.sessions })
		options.rebuilds = scheduler
		const report = Promise.withResolvers<void>()
		options.postStateToWebview.mockReturnValueOnce(report.promise)
		options.sessionConfigBuilder.build.mockRejectedValueOnce(new Error("failure"))
		coordinator.handleToolListChanged()
		await vi.waitFor(() => expect(options.messages.appendAndEmit).toHaveBeenCalledOnce())
		coordinator.sessionBecameIdle()
		scheduler.sessionBecameIdle()
		report.resolve()
		await vi.waitFor(() => expect(options.sessions.replaceActiveSession).toHaveBeenCalledOnce())
		expect(options.sessionConfigBuilder.build).toHaveBeenCalledTimes(2)
	})

	it("describes added and removed servers in the next turn notice", async () => {
		const a = makeActiveSession({ isRunning: true })
		const { options } = makeCoordinator({ activeSession: a })
		let snapshot: Record<string, string[]> = { old: ["read"] }
		options.getToolSnapshot = () => snapshot
		const coordinator = new SdkMcpCoordinator(options)
		snapshot = { docs: ["search", "fetch"] }
		coordinator.handleToolListChanged()
		await coordinator.restartSessionForMcpTools()
		const notice = coordinator.consumeMcpChangeNotice("new-session")
		expect(notice).toContain("added server docs (tools search, fetch)")
		expect(notice).toContain("removed server old")
		expect(coordinator.consumeMcpChangeNotice("new-session")).toBeUndefined()
	})

	it("clears pending MCP work when a retained session is removed", async () => {
		const a = makeActiveSession({ isRunning: true })
		const { coordinator } = makeCoordinator({ activeSession: a })
		coordinator.handleToolListChanged()
		coordinator.forgetSession(a.sessionId)
		expect(coordinator.consumeMcpChangeNotice(a.sessionId)).toBeUndefined()
	})

	it("emits an error message when restart fails", async () => {
		const activeSession = makeActiveSession()
		const { coordinator, options } = makeCoordinator({ activeSession })
		options.sessions.replaceActiveSession.mockRejectedValue(new Error("boom"))

		await coordinator.restartSessionForMcpTools()

		expect(options.messages.appendAndEmit).toHaveBeenLastCalledWith(
			[
				expect.objectContaining({
					type: "say",
					say: "error",
					text: "Failed to reload MCP tools: boom. MCP tools may be outdated.",
				}),
			],
			{ type: "status", payload: { sessionId: "old-session", status: "idle" } },
		)
		expect(options.postStateToWebview).toHaveBeenCalledOnce()
	})
})

function makeCoordinator(input: Partial<MakeCoordinatorInput> = {}) {
	const activeSession = input.activeSession
	const config = {
		providerId: "anthropic",
		modelId: "claude",
		apiKey: "key",
	}
	const options = {
		stateManager: {
			getGlobalSettingsKey: vi.fn(() => input.mode ?? "act"),
		} as unknown as StateManager,
		sessions: {
			getActiveSession: vi.fn(() => activeSession),
			replaceActiveSession: vi.fn(async (input) => {
				await input.loadInitialMessages?.()
				input.onReplaced?.("new-session")
				return { startResult: { sessionId: "new-session" }, sdkHost: { send: vi.fn() } }
			}),
		},
		messages: {
			appendAndEmit: vi.fn(),
			emitSessionEvents: vi.fn(),
		},
		sessionConfigBuilder: {
			build: vi.fn().mockResolvedValue(config),
		},
		getWorkspaceRoot: vi.fn().mockResolvedValue("/workspace"),
		loadInitialMessages: vi.fn().mockResolvedValue([{ role: "user", content: "hello" }]),
		buildStartSessionInput: vi.fn(() => ({ prompt: "start" })),
		postStateToWebview: vi.fn().mockResolvedValue(undefined),
		rebuilds: {
			request: vi.fn((_reason: string, rebuild: (context: { isCurrent: () => boolean }) => Promise<void>) => {
				if (!activeSession?.isRunning) {
					void rebuild({ isCurrent: () => true })
				}
			}),
		},
	} as unknown as SdkMcpCoordinatorOptions & {
		stateManager: StateManager & { getGlobalSettingsKey: ReturnType<typeof vi.fn> }
		sessions: SdkMcpCoordinatorOptions["sessions"] & {
			getActiveSession: ReturnType<typeof vi.fn>
			replaceActiveSession: ReturnType<typeof vi.fn>
		}
		messages: SdkMcpCoordinatorOptions["messages"] & {
			appendAndEmit: ReturnType<typeof vi.fn>
			emitSessionEvents: ReturnType<typeof vi.fn>
		}
		sessionConfigBuilder: SdkMcpCoordinatorOptions["sessionConfigBuilder"] & { build: ReturnType<typeof vi.fn> }
		getWorkspaceRoot: ReturnType<typeof vi.fn>
		loadInitialMessages: ReturnType<typeof vi.fn>
		buildStartSessionInput: ReturnType<typeof vi.fn>
		postStateToWebview: ReturnType<typeof vi.fn>
	}

	return {
		coordinator: new SdkMcpCoordinator(options),
		options,
	}
}

interface MakeCoordinatorInput {
	activeSession: ReturnType<typeof makeActiveSession>
	mode: "act" | "plan"
}

function makeActiveSession(input: { isRunning?: boolean } = {}) {
	return {
		sessionId: "old-session",
		sdkHost: {
			send: vi.fn(),
			stop: vi.fn().mockResolvedValue(undefined),
			dispose: vi.fn().mockResolvedValue(undefined),
		},
		unsubscribe: vi.fn(),
		startResult: { sessionId: "old-session" },
		isRunning: input.isRunning ?? false,
	}
}
