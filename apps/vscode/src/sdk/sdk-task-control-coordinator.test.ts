import type { ClineMessage } from "@shared/ExtensionMessage"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { SdkInteractionCoordinator } from "./sdk-interaction-coordinator"
import { SdkMessageCoordinator } from "./sdk-message-coordinator"
import { SdkTaskControlCoordinator, type SdkTaskControlCoordinatorOptions } from "./sdk-task-control-coordinator"
import { createTaskProxy } from "./task-proxy"

vi.mock("@/shared/services/Logger", () => ({
	Logger: {
		debug: vi.fn(),
		error: vi.fn(),
		log: vi.fn(),
		warn: vi.fn(),
	},
}))

describe("SdkTaskControlCoordinator", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("cancels the active session and emits a resume task ask", async () => {
		const activeSession = makeActiveSession()
		const { coordinator, options } = makeCoordinator({ activeSession })

		await coordinator.cancelTask()

		expect(options.interactions.clearPending).toHaveBeenCalledWith("Task cancelled")
		expect(activeSession.sdkHost.abort).toHaveBeenCalledWith("session-123")
		expect(options.sessions.cancelHeldSends).toHaveBeenCalledWith("session-123")
		expect(options.sessions.cancelHeldSends.mock.invocationCallOrder[0]).toBeLessThan(
			activeSession.sdkHost.abort.mock.invocationCallOrder[0],
		)
		expect(options.sessions.setRunning).toHaveBeenCalledWith(false)
		expect(options.messages.appendAndEmit).toHaveBeenCalledWith(
			[expect.objectContaining({ type: "ask", ask: "resume_task" })],
			{ type: "status", payload: { sessionId: "session-123", status: "cancelled" } },
		)
		expect(options.postStateToWebview).toHaveBeenCalledOnce()
	})

	it("aborts an interject without adding a resumable message", async () => {
		const { coordinator, options } = makeCoordinator({ activeSession: makeActiveSession() })
		await coordinator.cancelTask(false)
		expect(options.raiseCancelFence).toHaveBeenCalledOnce()
		expect(options.messages.appendAndEmit).not.toHaveBeenCalled()
	})

	it("fences interject then uses the SDK atomic abort and priority-send path", async () => {
		const active = makeActiveSession()
		const { coordinator, options } = makeCoordinator({ activeSession: active })
		await coordinator.cancelTask(false, { text: "Next", images: ["image"], files: ["file"] })
		expect(options.raiseCancelFence).toHaveBeenCalledOnce()
		expect(options.sessions.fireAndForgetSend).toHaveBeenCalledWith(
			active.sdkHost,
			"session-123",
			"Next",
			["image"],
			["file"],
			"interject",
		)
		expect(options.messages.appendAndEmit).not.toHaveBeenCalled()
		expect(options.sessions.setRunning).not.toHaveBeenCalled()
		expect(options.sessions.cancelHeldSends).not.toHaveBeenCalled()
	})

	it("opens a saved child transcript without offering to resume it or stopping its parent", async () => {
		const { coordinator, options } = makeCoordinator({ hasHistoryItem: true })
		options.taskHistory.findHistoryItem.mockResolvedValueOnce({
			id: "child",
			task: "Report",
			isSubagent: true,
			parentTaskId: "parent",
		})
		options.taskHistory.getClineMessages.mockResolvedValueOnce([
			{ ts: 1, type: "say", say: "task", text: "Report" },
			{ ts: 2, type: "say", say: "completion_result", text: "# Full report" },
		])
		await coordinator.showTaskWithId("child")
		const task = options.setTask.mock.calls[0][0]
		expect(task.messageStateHandler.getClineMessages()).toHaveLength(2)
		expect(
			task.messageStateHandler
				.getClineMessages()
				.some((message: ClineMessage) => message.ask === "resume_task" || message.ask === "resume_completed_task"),
		).toBe(false)
		expect(options.sessions.endActiveSession).not.toHaveBeenCalled()
	})

	it("focuses an existing live task without reloading or stopping it", async () => {
		const { options } = makeCoordinator({ hasHistoryItem: true })
		const focusLiveTask = vi.fn(() => true)
		await new SdkTaskControlCoordinator({ ...options, focusLiveTask }).showTaskWithId("task-1")
		expect(focusLiveTask).toHaveBeenCalledWith("task-1", expect.objectContaining({ id: "task-1" }))
		expect(options.taskHistory.getClineMessages).not.toHaveBeenCalled()
		expect(options.sessions.endActiveSession).not.toHaveBeenCalled()
		expect(options.interactions.clearPending).not.toHaveBeenCalled()
	})

	it("cancels a running Cline task when the user signs out", async () => {
		const activeSession = makeActiveSession()
		const { coordinator, options } = makeCoordinator({ activeSession })

		await coordinator.cancelClineTaskOnSignOut(true)

		expect(activeSession.sdkHost.abort).toHaveBeenCalledWith("session-123")
		expect(options.sessions.setRunning).toHaveBeenCalledWith(false)
	})

	it("does not cancel a non-Cline task when the user signs out", async () => {
		const activeSession = makeActiveSession()
		const { coordinator, options } = makeCoordinator({ activeSession })

		await coordinator.cancelClineTaskOnSignOut(false)

		expect(activeSession.sdkHost.abort).not.toHaveBeenCalled()
		expect(options.sessions.setRunning).not.toHaveBeenCalled()
	})

	it("raises the cancel fence BEFORE aborting the session (so stragglers are fenced)", async () => {
		const activeSession = makeActiveSession()
		const { coordinator, options } = makeCoordinator({ activeSession })

		const order: string[] = []
		;(options.raiseCancelFence as ReturnType<typeof vi.fn>).mockImplementation(() => order.push("fence"))
		;(activeSession.sdkHost.abort as ReturnType<typeof vi.fn>).mockImplementation(async () => {
			order.push("abort")
		})

		await coordinator.cancelTask()

		expect(options.raiseCancelFence).toHaveBeenCalledOnce()
		expect(order).toEqual(["fence", "abort"])
	})

	it("clears the active session and task proxy without writing classic UI message persistence", async () => {
		const activeSession = makeActiveSession()
		const task = makeTask("task-1", [{ ts: 1, type: "say", say: "text", text: "hi", partial: true }])
		const { coordinator, options, state } = makeCoordinator({ activeSession, task })

		await coordinator.clearTask()

		expect(options.interactions.clearPending).not.toHaveBeenCalled()
		expect(options.rebuilds.runTaskTransition).toHaveBeenCalledOnce()
		expect(options.sessions.endActiveSession).not.toHaveBeenCalled()
		expect(options.sessions.focusSession).toHaveBeenCalledWith()
		expect(options.sessions.cancelHeldSends).toHaveBeenCalledWith("session-123")
		expect(options.messages.finalizeMessagesForSave).not.toHaveBeenCalled()
		expect(options.messages.cancelPendingSave).toHaveBeenCalledOnce()
		expect(task.messageStateHandler.clear).not.toHaveBeenCalled()
		expect(state.task).toBeUndefined()
		expect(options.resetMessageTranslator).not.toHaveBeenCalled()
	})

	it("waits for the task-transition boundary before ending the active session", async () => {
		let releaseRebuild: () => void = () => {}
		const { coordinator, options } = makeCoordinator({ activeSession: makeActiveSession() })
		options.rebuilds.runTaskTransition.mockImplementationOnce(
			(operation: () => Promise<void>) =>
				new Promise<void>((resolve) => {
					releaseRebuild = () => {
						void operation().then(resolve)
					}
				}),
		)

		const clear = coordinator.clearTask()
		await Promise.resolve()

		expect(options.sessions.cancelHeldSends).toHaveBeenCalledWith("session-123")
		expect(options.sessions.endActiveSession).not.toHaveBeenCalled()

		releaseRebuild()
		await clear

		expect(options.sessions.endActiveSession).not.toHaveBeenCalled()
		expect(options.sessions.focusSession).toHaveBeenCalledWith()
	})

	it("does not end the session when a task selection supersedes clearTask during the rebuild wait", async () => {
		let releaseRebuild: () => void = () => {}
		const { coordinator, options } = makeCoordinator({ activeSession: makeActiveSession() })
		options.rebuilds.runTaskTransition.mockImplementationOnce(
			(operation: () => Promise<void>) =>
				new Promise<void>((resolve) => {
					releaseRebuild = () => {
						void operation().then(resolve)
					}
				}),
		)

		const clear = coordinator.clearTask()
		void coordinator.showTaskWithId("missing-task")
		releaseRebuild()
		await clear

		expect(options.sessions.endActiveSession).not.toHaveBeenCalledWith("clearTask")
	})

	it("drops the task-scoped settings overlay when the task is cleared (#13260)", async () => {
		// autoApprovalSettings written via setTaskSettings while a task is open
		// shadow global settings in getGlobalSettingsKey(). If the overlay
		// survives "New Task", later global updates are accepted but never
		// reach the webview (the stale overlay version wins), freezing the
		// auto-approve checkboxes.
		const { coordinator, options } = makeCoordinator({
			activeSession: makeActiveSession(),
			task: makeTask("task-1"),
		})

		await coordinator.clearTask()

		expect(options.clearTaskSettings).toHaveBeenCalledOnce()
	})

	it("drops the outgoing task's settings overlay when switching to another task", async () => {
		const { coordinator, options } = makeCoordinator({
			activeSession: makeActiveSession(),
			task: makeTask("old-task"),
			hasHistoryItem: true,
			clineMessages: [{ ts: 1, type: "say", say: "task", text: "hello" }],
			sessionStatus: "completed",
		})

		await coordinator.showTaskWithId("task-1")

		expect(options.rebuilds.runTaskTransition).toHaveBeenCalledOnce()
		expect(options.clearTaskSettings).toHaveBeenCalledOnce()
		// The overlay must be gone before the new proxy is installed.
		expect(options.clearTaskSettings.mock.invocationCallOrder[0]).toBeLessThan(options.setTask.mock.invocationCallOrder[0])
	})

	it("shows a task by creating a proxy, loading messages, and appending a fresh resume ask", async () => {
		const existingTask = makeTask("old-task")
		const activeSession = makeActiveSession()
		const sdkClineMessages: ClineMessage[] = [
			{ ts: 1, type: "say", say: "task", text: "hello" },
			{ ts: 2, type: "ask", ask: "completion_result", text: "" },
		]
		const { coordinator, options, state } = makeCoordinator({
			activeSession,
			task: existingTask,
			hasHistoryItem: true,
			clineMessages: sdkClineMessages,
			sessionStatus: "completed",
		})

		await coordinator.showTaskWithId("task-1")

		expect(options.taskHistory.findHistoryItem).toHaveBeenCalledWith("task-1")
		expect(options.sessions.endActiveSession).not.toHaveBeenCalled()
		expect(options.sessions.focusSession).toHaveBeenCalledWith("task-1")
		expect(existingTask.messageStateHandler.clear).not.toHaveBeenCalled()
		expect(options.resetMessageTranslator).not.toHaveBeenCalled()
		expect(state.task?.taskId).toBe("task-1")
		expect(options.taskHistory.getClineMessages).toHaveBeenCalledWith("task-1")
		expect(state.task?.messageStateHandler.getClineMessages()).toEqual([
			{ ts: 1, type: "say", say: "task", text: "hello" },
			{ ts: 2, type: "ask", ask: "completion_result", text: "" },
			expect.objectContaining({ type: "ask", ask: "resume_completed_task" }),
		])
		expect(options.postStateToWebview).toHaveBeenCalledOnce()
	})

	it.each(["cancel", "interject"])("clears active and queued child approvals on parent %s", async (action) => {
		const task = createTaskProxy("session-123", vi.fn(), vi.fn())
		const interactions = new SdkInteractionCoordinator({
			messages: new SdkMessageCoordinator({ getTask: () => task }),
			getSessionId: () => task.taskId,
			postStateToWebview: vi.fn().mockResolvedValue(undefined),
		})
		const { options } = makeCoordinator({ activeSession: makeActiveSession() })
		const coordinator = new SdkTaskControlCoordinator({ ...options, interactions })
		const approvals = ["child-1", "child-2"].map((id) =>
			interactions.handleRequestToolApproval({
				agentId: id,
				conversationId: id,
				iteration: 1,
				toolCallId: id,
				toolName: "editor",
				input: {},
				policy: { autoApprove: false },
				signal: new AbortController().signal,
			}),
		)
		await vi.waitFor(() => expect(task.messageStateHandler.getClineMessages()).toHaveLength(1))
		await coordinator.cancelTask(false, action === "interject" ? { text: "new direction" } : undefined)
		for (const approval of approvals) await expect(approval).resolves.toMatchObject({ approved: false })
		expect(task.messageStateHandler.getClineMessages()).toHaveLength(0)
		expect(
			interactions.resolvePendingToolApproval(
				undefined,
				"yesButtonClicked",
				undefined,
				undefined,
				interactions.getPendingDecision()?.id,
			),
		).toBe(false)
		if (action === "interject") expect(options.sessions.fireAndForgetSend).toHaveBeenCalled()
		else expect(options.sessions.getActiveSession()?.sdkHost.abort).toHaveBeenCalled()
	})

	it("preserves a background approval across task switching", async () => {
		const pendingTask = createTaskProxy("old-task", vi.fn(), vi.fn())
		const interactions = new SdkInteractionCoordinator({
			messages: new SdkMessageCoordinator({ getTask: () => pendingTask }),
			getSessionId: () => pendingTask.taskId,
			postStateToWebview: vi.fn().mockResolvedValue(undefined),
		})
		const { options } = makeCoordinator({
			activeSession: makeActiveSession(),
			hasHistoryItem: true,
			clineMessages: [],
		})
		const coordinator = new SdkTaskControlCoordinator({ ...options, interactions })
		const approvalPromise = interactions.handleRequestToolApproval({
			agentId: "agent",
			conversationId: "conversation",
			iteration: 1,
			toolCallId: "tool-call",
			toolName: "read_files",
			input: {},
			policy: { autoApprove: false },
		})
		await vi.waitFor(() => expect(pendingTask.messageStateHandler.getClineMessages()).toHaveLength(1))

		await coordinator.showTaskWithId("new-task")

		expect(
			interactions.resolvePendingToolApproval(
				undefined,
				"yesButtonClicked",
				undefined,
				undefined,
				interactions.getPendingDecision()?.id,
			),
		).toBe(true)
		await expect(approvalPromise).resolves.toEqual({ approved: true })
	})

	it("preserves a background question across task switching", async () => {
		const pendingTask = createTaskProxy("old-task", vi.fn(), vi.fn())
		const interactions = new SdkInteractionCoordinator({
			messages: new SdkMessageCoordinator({ getTask: () => pendingTask }),
			getSessionId: () => pendingTask.taskId,
			postStateToWebview: vi.fn().mockResolvedValue(undefined),
		})
		const { options } = makeCoordinator({
			activeSession: makeActiveSession(),
			hasHistoryItem: true,
			clineMessages: [],
		})
		const coordinator = new SdkTaskControlCoordinator({ ...options, interactions })
		const questionPromise = interactions.handleAskQuestion("Which option?", ["A", "B"], {})
		await vi.waitFor(() => expect(pendingTask.messageStateHandler.getClineMessages()).toHaveLength(1))

		await coordinator.showTaskWithId("new-task")

		expect(interactions.resolvePendingAskQuestion("late answer", interactions.getPendingDecision()?.id)).toBe(true)
		await expect(questionPromise).resolves.toBe("late answer")
	})

	it("shows a legacy task with a warning and a resume ask", async () => {
		const legacyMessages: ClineMessage[] = [{ ts: 1, type: "say", say: "task", text: "legacy task" }]
		const { coordinator, options, state } = makeCoordinator({
			hasHistoryItem: true,
			clineMessages: legacyMessages,
			isLegacyTask: true,
		})

		await coordinator.showTaskWithId("legacy-task")

		expect(options.taskHistory.isLegacyTask).toHaveBeenCalledWith("legacy-task")
		expect(state.task?.messageStateHandler.getClineMessages()).toEqual([
			{ ts: 1, type: "say", say: "task", text: "legacy task" },
			expect.objectContaining({
				type: "say",
				say: "text",
				text: expect.stringContaining("legacy task"),
			}),
			expect.objectContaining({ type: "ask", ask: "resume_task" }),
		])
	})

	it("focuses a live session that has no persisted history item yet", async () => {
		// A just-started chat outruns its persisted history record (Core writes it
		// when the first send lands). Closing it with X unfocuses the session but
		// keeps it running, so the inbox row must reopen through the live path.
		const { options } = makeCoordinator({ hasHistoryItem: false })
		const liveItem = { id: "live-1", ts: 5, task: "bg task", tokensIn: 0, tokensOut: 0, totalCost: 0 }
		const focusLiveTask = vi.fn(() => true)
		const getLiveTaskItem = vi.fn((id: string) => (id === "live-1" ? liveItem : undefined))
		const coordinator = new SdkTaskControlCoordinator({ ...options, focusLiveTask, getLiveTaskItem })

		const result = await coordinator.showTaskWithId("live-1")

		expect(getLiveTaskItem).toHaveBeenCalledWith("live-1")
		expect(focusLiveTask).toHaveBeenCalledWith("live-1", expect.objectContaining({ id: "live-1" }))
		expect(result).toMatchObject({ id: "live-1" })
		expect(options.taskHistory.getClineMessages).not.toHaveBeenCalled()
	})

	it("does not show a task that is missing from history", async () => {
		const { coordinator, options } = makeCoordinator({ hasHistoryItem: false })

		await coordinator.showTaskWithId("missing-task")

		expect(options.setTask).not.toHaveBeenCalled()
		expect(options.taskHistory.getClineMessages).not.toHaveBeenCalled()
		expect(options.setTurnPhase).not.toHaveBeenCalled()
	})

	it("appends a resume ask and sets the resumable phase when showing an interrupted (cancelled) task", async () => {
		// History rendering appends a synthetic trailing ask:"completion_result"
		// to every reopened conversation, so the persisted session status — not
		// the message tail — must decide the resume affordance.
		const sdkClineMessages: ClineMessage[] = [
			{ ts: 1, type: "say", say: "task", text: "hello" },
			{ ts: 2, type: "ask", ask: "completion_result", text: "" },
		]
		const { coordinator, options, state } = makeCoordinator({
			hasHistoryItem: true,
			clineMessages: sdkClineMessages,
			sessionStatus: "cancelled",
		})

		await coordinator.showTaskWithId("task-1")

		expect(state.task?.messageStateHandler.getClineMessages().at(-1)).toEqual(
			expect.objectContaining({ type: "ask", ask: "resume_task" }),
		)
		expect(options.setTurnPhase).toHaveBeenCalledWith("resumable", expect.any(Number))
	})

	it("sets the turn phase to resumable when showing a failed task", async () => {
		const sdkClineMessages: ClineMessage[] = [
			{ ts: 1, type: "say", say: "task", text: "hello" },
			{ ts: 2, type: "say", say: "text", text: "partial answer" },
		]
		const { coordinator, options } = makeCoordinator({
			hasHistoryItem: true,
			clineMessages: sdkClineMessages,
			sessionStatus: "failed",
		})

		await coordinator.showTaskWithId("task-1")

		expect(options.setTurnPhase).toHaveBeenCalledWith("resumable", expect.any(Number))
	})

	it("sets the turn phase to completed when showing a completed task", async () => {
		const sdkClineMessages: ClineMessage[] = [
			{ ts: 1, type: "say", say: "task", text: "hello" },
			{ ts: 2, type: "ask", ask: "completion_result", text: "" },
		]
		const { coordinator, options, state } = makeCoordinator({
			hasHistoryItem: true,
			clineMessages: sdkClineMessages,
			sessionStatus: "completed",
		})

		await coordinator.showTaskWithId("task-1")

		expect(state.task?.messageStateHandler.getClineMessages().at(-1)).toEqual(
			expect.objectContaining({ type: "ask", ask: "resume_completed_task" }),
		)
		expect(options.setTurnPhase).toHaveBeenCalledWith("completed", expect.any(Number))
	})

	it("sets the turn phase to idle when showing a task with no messages", async () => {
		const { coordinator, options } = makeCoordinator({
			hasHistoryItem: true,
			clineMessages: [],
		})

		await coordinator.showTaskWithId("task-1")

		expect(options.setTurnPhase).toHaveBeenCalledWith("idle")
	})

	it("keeps the newest selection when an older open's history lookup resolves last", async () => {
		const { coordinator, options, state } = makeCoordinator({
			hasHistoryItem: true,
			clineMessages: [{ ts: 1, type: "say", say: "task", text: "hello" }],
			sessionStatus: "cancelled",
		})

		// Task A's preflight history lookup stalls. The view generation must be
		// allocated BEFORE this await: when the lookup used to live in
		// SdkController ahead of the coordinator, a stalled lookup re-entered
		// with a NEWER generation than a later selection and replaced it.
		let resolveLookup: ((item: unknown) => void) | undefined
		options.taskHistory.findHistoryItem.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveLookup = resolve
				}),
		)

		const staleOpen = coordinator.showTaskWithId("task-old")

		// Task B is selected afterwards and loads successfully.
		await coordinator.showTaskWithId("task-new")
		expect(state.task?.taskId).toBe("task-new")
		const endActiveSessionCalls = options.sessions.endActiveSession.mock.calls.length

		// Task A's lookup finally resolves. It must neither stop the session the
		// newer selection installed nor replace the selection.
		resolveLookup?.({ id: "task-old", ts: 1, task: "old", tokensIn: 0, tokensOut: 0, totalCost: 0 })
		const staleResult = await staleOpen

		expect(staleResult).toBeDefined()
		expect(state.task?.taskId).toBe("task-new")
		expect(options.sessions.endActiveSession.mock.calls.length).toBe(endActiveSessionCalls)
	})

	it("abandons a superseded showTaskWithId so the newest selection wins", async () => {
		const { coordinator, options, state } = makeCoordinator({
			hasHistoryItem: true,
			clineMessages: [{ ts: 1, type: "say", say: "task", text: "hello" }],
			sessionStatus: "cancelled",
		})

		// Park the FIRST open on its message read so a second open can start
		// and finish while the first is still in flight.
		let resolveFirstRead: ((messages: ClineMessage[]) => void) | undefined
		options.taskHistory.getClineMessages.mockImplementationOnce(
			() =>
				new Promise<ClineMessage[]>((resolve) => {
					resolveFirstRead = resolve
				}),
		)

		const firstOpen = coordinator.showTaskWithId("task-old")
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(resolveFirstRead).toBeDefined()

		await coordinator.showTaskWithId("task-new")
		expect(state.task?.taskId).toBe("task-new")
		const phaseCallsAfterSecondOpen = options.setTurnPhase.mock.calls.length

		resolveFirstRead?.([{ ts: 1, type: "say", say: "task", text: "stale" }])
		await firstOpen

		// The stale open must not replace the newer selection or its turn phase.
		expect(state.task?.taskId).toBe("task-new")
		expect(state.task?.messageStateHandler.getClineMessages().length).toBeGreaterThan(0)
		expect(options.setTurnPhase.mock.calls.length).toBe(phaseCallsAfterSecondOpen)
	})

	it("abandons a superseded showTaskWithId when the user clears the task", async () => {
		const { coordinator, options, state } = makeCoordinator({
			hasHistoryItem: true,
			clineMessages: [{ ts: 1, type: "say", say: "task", text: "hello" }],
			sessionStatus: "cancelled",
		})

		let resolveRead: ((messages: ClineMessage[]) => void) | undefined
		options.taskHistory.getClineMessages.mockImplementationOnce(
			() =>
				new Promise<ClineMessage[]>((resolve) => {
					resolveRead = resolve
				}),
		)

		const open = coordinator.showTaskWithId("task-old")
		await new Promise((resolve) => setTimeout(resolve, 0))

		await coordinator.clearTask()
		resolveRead?.([{ ts: 1, type: "say", say: "task", text: "stale" }])
		await open

		expect(state.task).toBeUndefined()
	})

	it("does not install the new task proxy until its messages are loaded", async () => {
		const sdkClineMessages: ClineMessage[] = [
			{ ts: 1, type: "say", say: "task", text: "hello" },
			{ ts: 2, type: "ask", ask: "completion_result", text: "" },
		]

		let resolveGetClineMessages: ((messages: ClineMessage[]) => void) | undefined
		const getClineMessagesDeferred = new Promise<ClineMessage[]>((resolve) => {
			resolveGetClineMessages = resolve
		})

		const { coordinator, options, state } = makeCoordinator({
			hasHistoryItem: true,
			clineMessages: sdkClineMessages,
		})
		options.taskHistory.getClineMessages.mockReturnValueOnce(getClineMessagesDeferred)

		let setTaskHadMessages: boolean | undefined
		options.setTask.mockImplementation((task: any) => {
			setTaskHadMessages = (task?.messageStateHandler?.getClineMessages?.() ?? []).length > 0
			state.task = task
		})

		const inFlight = coordinator.showTaskWithId("task-1")

		// While getClineMessages is still pending, the new task proxy must not be
		// installed — otherwise concurrent postStateToWebview() callers would see
		// currentTaskItem.id with an empty messageStateHandler.
		await Promise.resolve()
		await Promise.resolve()
		expect(options.setTask).not.toHaveBeenCalled()
		expect(state.task).toBeUndefined()

		resolveGetClineMessages?.(sdkClineMessages)
		await inFlight

		expect(options.setTask).toHaveBeenCalledTimes(1)
		expect(setTaskHadMessages).toBe(true)
		expect(state.task?.taskId).toBe("task-1")
		expect(options.postStateToWebview).toHaveBeenCalledOnce()
	})
})

function makeCoordinator(input: Partial<MakeCoordinatorInput> = {}) {
	const state: { task?: ReturnType<typeof makeTask> } = {
		task: input.task,
	}
	const options = {
		sessions: {
			getActiveSession: vi.fn(() => input.activeSession),
			endActiveSession: vi.fn().mockResolvedValue(input.activeSession),
			focusSession: vi.fn(),
			fireAndForgetSend: vi.fn(),
			cancelHeldSends: vi.fn(),
			setRunning: vi.fn(),
		},
		interactions: {
			clearPending: vi.fn(),
		},
		messages: {
			appendAndEmit: vi.fn(),
			appendMessages: vi.fn(),
			cancelPendingSave: vi.fn(),
			finalizeMessagesForSave: vi.fn((messages: ClineMessage[]) =>
				messages.map((message) => {
					if (!message.partial) {
						return message
					}
					const { partial: _partial, ...rest } = message
					return { ...rest, text: "final" }
				}),
			),
		},
		taskHistory: {
			getClineMessages: vi.fn().mockResolvedValue(input.clineMessages ?? []),
			getSessionStatus: vi.fn().mockResolvedValue(input.sessionStatus),
			isLegacyTask: vi.fn().mockResolvedValue(input.isLegacyTask ?? false),
			findHistoryItem: vi.fn(() =>
				input.hasHistoryItem === false
					? undefined
					: {
							id: "task-1",
							ts: 1,
							task: "hello",
							tokensIn: 0,
							tokensOut: 0,
							totalCost: 0,
						},
			),
		},
		getTask: vi.fn(() => state.task),
		setTask: vi.fn((task) => {
			state.task = task as ReturnType<typeof makeTask> | undefined
		}),
		onAskResponse: vi.fn().mockResolvedValue(undefined),
		resetMessageTranslator: vi.fn(),
		raiseCancelFence: vi.fn(),
		setTurnPhase: vi.fn(),
		postStateToWebview: vi.fn().mockResolvedValue(undefined),
		clearTaskSettings: vi.fn().mockResolvedValue(undefined),
		rebuilds: {
			runTaskTransition: vi.fn(async (operation: () => Promise<unknown>) => operation()),
		},
	} as unknown as SdkTaskControlCoordinatorOptions & {
		sessions: SdkTaskControlCoordinatorOptions["sessions"] & {
			getActiveSession: ReturnType<typeof vi.fn>
			endActiveSession: ReturnType<typeof vi.fn>
			focusSession: ReturnType<typeof vi.fn>
			fireAndForgetSend: ReturnType<typeof vi.fn>
			cancelHeldSends: ReturnType<typeof vi.fn>
			setRunning: ReturnType<typeof vi.fn>
		}
		interactions: SdkTaskControlCoordinatorOptions["interactions"] & { clearPending: ReturnType<typeof vi.fn> }
		messages: SdkTaskControlCoordinatorOptions["messages"] & {
			appendAndEmit: ReturnType<typeof vi.fn>
			appendMessages: ReturnType<typeof vi.fn>
			cancelPendingSave: ReturnType<typeof vi.fn>
			finalizeMessagesForSave: ReturnType<typeof vi.fn>
		}
		taskHistory: SdkTaskControlCoordinatorOptions["taskHistory"] & {
			findHistoryItem: ReturnType<typeof vi.fn>
			getClineMessages: ReturnType<typeof vi.fn>
			isLegacyTask: ReturnType<typeof vi.fn>
		}
		getTask: ReturnType<typeof vi.fn>
		setTask: ReturnType<typeof vi.fn>
		resetMessageTranslator: ReturnType<typeof vi.fn>
		setTurnPhase: ReturnType<typeof vi.fn>
		postStateToWebview: ReturnType<typeof vi.fn>
		clearTaskSettings: ReturnType<typeof vi.fn>
		rebuilds: { runTaskTransition: ReturnType<typeof vi.fn> }
	}

	return {
		coordinator: new SdkTaskControlCoordinator(options),
		options,
		state,
	}
}

interface MakeCoordinatorInput {
	activeSession: ReturnType<typeof makeActiveSession>
	task: ReturnType<typeof makeTask>
	hasHistoryItem: boolean
	clineMessages: ClineMessage[]
	isLegacyTask: boolean
	sessionStatus: string
}

function makeActiveSession() {
	return {
		sessionId: "session-123",
		sdkHost: {
			abort: vi.fn().mockResolvedValue(undefined),
			stop: vi.fn().mockResolvedValue(undefined),
			dispose: vi.fn().mockResolvedValue(undefined),
		},
		unsubscribe: vi.fn(),
		isRunning: true,
	}
}

function makeTask(taskId: string, messages: ClineMessage[] = []) {
	return {
		taskId,
		messageStateHandler: {
			getClineMessages: vi.fn(() => messages),
			clear: vi.fn(),
		},
	}
}

it("reloads the selected saved child transcript and preserves its nested relationship", async () => {
	const messages: ClineMessage[] = [
		{ ts: 1, type: "say", say: "task", text: "B" },
		{ ts: 2, type: "say", say: "text", text: "Full nested report" },
	]
	const { coordinator, options, state } = makeCoordinator({ clineMessages: messages, sessionStatus: "completed" })
	const child = {
		id: "root__b",
		ts: 1,
		task: "B",
		tokensIn: 0,
		tokensOut: 0,
		totalCost: 0,
		isSubagent: true,
		parentTaskId: "root__a",
		runtimeOwnerTaskId: "root",
		agentId: "b",
	}
	options.taskHistory.findHistoryItem.mockResolvedValue(child)
	await coordinator.showTaskWithId(child.id)
	expect(state.task?.taskId).toBe(child.id)
	expect(state.task?.messageStateHandler.getClineMessages()).toEqual(messages)
	await coordinator.showTaskWithId(child.id)
	expect(state.task?.messageStateHandler.getClineMessages()).toEqual(messages)
	expect(options.applyTaskApiSelection).toBeUndefined()
	expect(options.sessions.endActiveSession).not.toHaveBeenCalled()
})
