import type { HistoryItem } from "@shared/HistoryItem"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { StateManager } from "@/core/storage/StateManager"
import { isDirectory } from "@/utils/fs"
import { PROVIDER_FAILURE_ERROR_TYPE, PROVIDER_FAILURE_PHASE } from "./provider-failure-telemetry"
import { SdkTaskStartCoordinator, type SdkTaskStartCoordinatorOptions } from "./sdk-task-start-coordinator"
import { createTaskProxy } from "./task-proxy"

vi.mock("@/shared/services/Logger", () => ({
	Logger: {
		error: vi.fn(),
		log: vi.fn(),
		warn: vi.fn(),
	},
}))

vi.mock("@/utils/fs", () => ({
	isDirectory: vi.fn(),
}))

describe("SdkTaskStartCoordinator", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(isDirectory).mockResolvedValue(false)
	})

	it("initializes a new task, emits the task message, and sends the resolved prompt", async () => {
		const { coordinator, options, state } = makeCoordinator()

		const sessionId = await coordinator.initTask("hello @file", ["image.png"], ["a.ts"])

		expect(sessionId).toEqual(expect.any(String))
		expect(options.clearTask).toHaveBeenCalledOnce()
		expect(options.sessionConfigBuilder.build).toHaveBeenCalledWith({
			prompt: "hello @file",
			images: ["image.png"],
			files: ["a.ts"],
			historyItem: undefined,
			taskSettings: undefined,
			cwd: "/workspace",
			mode: "act",
			apiSelection: {},
		})
		expect(options.buildStartSessionInput).toHaveBeenCalledWith(
			expect.objectContaining({ providerId: "anthropic", modelId: "model", sessionId }),
			expect.objectContaining({
				prompt: "hello @file",
				images: ["image.png"],
				files: ["a.ts"],
				cwd: "/workspace",
				mode: "act",
			}),
		)
		expect(state.task?.taskId).toBe(sessionId)
		expect(options.taskHistory.updateTaskHistoryItem).toHaveBeenCalledWith(
			expect.objectContaining({ id: sessionId, task: "hello @file", modelId: "model" }),
		)
		// Attachments must be on the authoritative task message so the webview's
		// optimistic pending copy (which carries them) gets confirmed and cleared.
		expect(options.messages.appendAndEmit).toHaveBeenCalledWith(
			[
				expect.objectContaining({
					type: "say",
					say: "task",
					text: "hello @file",
					images: ["image.png"],
					files: ["a.ts"],
				}),
			],
			{ type: "status", payload: { sessionId, status: "running" } },
		)
		expect(options.postStateToWebview).toHaveBeenCalledTimes(2)
		expect(options.messages.appendAndEmit.mock.invocationCallOrder[0]).toBeLessThan(
			options.sessions.startNewSession.mock.invocationCallOrder[0],
		)
		// The first state post carries the streaming TurnState to the webview (thinking
		// indicator) and must not wait for the potentially slow session startup.
		expect(options.postStateToWebview.mock.invocationCallOrder[0]).toBeLessThan(
			options.sessions.startNewSession.mock.invocationCallOrder[0],
		)
		expect(options.resolveContextMentions).toHaveBeenCalledWith("hello @file")
		expect(options.sessions.fireAndForgetSend).toHaveBeenCalledWith(
			expect.objectContaining({ send: expect.any(Function) }),
			sessionId,
			"resolved: hello @file",
			["image.png"],
			["a.ts"],
		)
	})

	it("starts a chat in the background without clearing or focusing the view", async () => {
		const { options, state } = makeCoordinator()
		const contextTask = createTaskProxy("", vi.fn(), vi.fn())
		const contextMessages = { appendAndEmit: vi.fn() }
		const createTaskContext = vi.fn((taskId: string) => {
			contextTask.taskId = taskId
			return { task: contextTask, messages: contextMessages }
		})
		const coordinator = new SdkTaskStartCoordinator({ ...options, createTaskContext })

		const sessionId = await coordinator.initTask("quiet task", ["image.png"], [], undefined, undefined, {
			background: true,
		})

		expect(sessionId).toEqual(expect.any(String))
		// The view is untouched: no clear, no focused task, and the task message is
		// written into the background task's own transcript, not the visible one.
		expect(options.clearTask).not.toHaveBeenCalled()
		expect(options.setTask).not.toHaveBeenCalled()
		expect(state.task).toBeUndefined()
		expect(createTaskContext).toHaveBeenCalledWith(sessionId)
		expect(contextTask.taskId).toBe(sessionId)
		expect(options.sessions.startNewSession).toHaveBeenCalledWith(
			expect.objectContaining({ config: expect.objectContaining({ sessionId }) }),
			{ focus: false },
		)
		expect(contextMessages.appendAndEmit).toHaveBeenCalledWith(
			[expect.objectContaining({ type: "say", say: "task", text: "quiet task", images: ["image.png"] })],
			{ type: "status", payload: { sessionId, status: "running" } },
		)
		expect(options.messages.appendAndEmit).not.toHaveBeenCalled()
		expect(options.taskHistory.updateTaskHistoryItem).toHaveBeenCalledWith(
			expect.objectContaining({ id: sessionId, task: "quiet task" }),
		)
		expect(options.sessions.fireAndForgetSend).toHaveBeenCalledWith(
			expect.anything(),
			sessionId,
			"resolved: quiet task",
			["image.png"],
			[],
		)
		expect(options.postStateToWebview).toHaveBeenCalled()
	})

	it("applies the home draft once, then starts the next chat from Settings defaults", async () => {
		const { options } = makeCoordinator()
		Object.assign(options.stateManager, {
			getGlobalStateKey: () => "P",
			getApiConfiguration: () => ({ actModeReasoningEffort: "low" }),
		})
		const draft = { actProfileId: "Q", actModeReasoningEffort: "high" as const }
		const consume = vi.fn().mockReturnValueOnce(draft).mockReturnValue(undefined)
		const coordinator = new SdkTaskStartCoordinator({ ...options, consumeDraftApiSelection: consume })
		await coordinator.initTask("draft chat")
		expect(options.sessionConfigBuilder.build).toHaveBeenLastCalledWith(expect.objectContaining({ apiSelection: draft }))
		await coordinator.initTask("default chat")
		expect(options.sessionConfigBuilder.build).toHaveBeenLastCalledWith(
			expect.objectContaining({
				apiSelection: { askProfileId: "P", actProfileId: "P", actModeReasoningEffort: "low" },
			}),
		)
	})

	it("pins the build selection through slow startup while another chat changes the picker", async () => {
		const { options } = makeCoordinator()
		let selected = "P"
		Object.assign(options.stateManager, {
			getGlobalStateKey: () => selected,
			getApiConfiguration: () => ({ actModeReasoningEffort: "low" }),
		})
		const record = vi.fn()
		const coordinatorWithRecord = new SdkTaskStartCoordinator({ ...options, recordTaskApiSelection: record })
		let release!: () => void
		const gate = new Promise<void>((resolve) => {
			release = resolve
		})
		options.sessions.startNewSession.mockImplementationOnce(async () => {
			selected = "Q"
			await gate
			return { startResult: { sessionId: "started" }, sdkHost: { send: vi.fn() } }
		})
		const start = coordinatorWithRecord.initTask("hello")
		await vi.waitFor(() => expect(options.sessions.startNewSession).toHaveBeenCalledOnce())
		expect(record).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ actProfileId: "P" }), "act")
		release()
		await start
		expect(options.taskHistory.updateTaskHistoryItem).toHaveBeenCalledWith(
			expect.objectContaining({
				apiSelection: expect.objectContaining({ actProfileId: "P", actModeReasoningEffort: "low" }),
			}),
		)
		expect(options.sessions.startNewSession).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionMetadata: expect.objectContaining({ apiSelection: expect.objectContaining({ actProfileId: "P" }) }),
			}),
		)
		expect(record).toHaveBeenLastCalledWith("started", expect.objectContaining({ actProfileId: "P" }), "act")
	})

	it("omits images/files from the task message when the task has no attachments", async () => {
		const { coordinator, options } = makeCoordinator()

		await coordinator.initTask("plain text task")

		const [emitted] = options.messages.appendAndEmit.mock.calls[0][0] as [Record<string, unknown>]
		expect(emitted).toMatchObject({ type: "say", say: "task", text: "plain text task" })
		expect(emitted).not.toHaveProperty("images")
		expect(emitted).not.toHaveProperty("files")
	})

	it("emits a Cline auth error instead of starting when the cline provider has no token", async () => {
		const { coordinator, options } = makeCoordinator({ config: { providerId: "cline", modelId: "model", apiKey: "" } })

		const sessionId = await coordinator.initTask("needs auth")

		expect(sessionId).toBeUndefined()
		expect(options.emitClineAuthError).toHaveBeenCalledWith("needs auth")
		expect(options.captureProviderApiError).not.toHaveBeenCalled()
		expect(options.sessions.startNewSession).not.toHaveBeenCalled()
	})

	it("emits a Cline auth error instead of starting when ClinePass has no token", async () => {
		const { coordinator, options } = makeCoordinator({ config: { providerId: "cline-pass", modelId: "model", apiKey: "" } })

		const sessionId = await coordinator.initTask("needs clinepass auth")

		expect(sessionId).toBeUndefined()
		expect(options.emitClineAuthError).toHaveBeenCalledWith("needs clinepass auth")
		expect(options.captureProviderApiError).not.toHaveBeenCalled()
		expect(options.sessions.startNewSession).not.toHaveBeenCalled()
	})

	it("emits a plain chat error when session start fails (e.g. provider misconfigured)", async () => {
		const { coordinator, options, state } = makeCoordinator()
		const error = new Error("No model configured for provider openai")
		options.sessions.startNewSession.mockRejectedValue(error)

		const sessionId = await coordinator.initTask("do something")

		expect(sessionId).toBeUndefined()
		expect(options.emitClineAuthError).not.toHaveBeenCalled()
		expect(options.captureProviderApiError).toHaveBeenCalledWith({
			sessionId: state.task?.taskId,
			error,
			providerId: "anthropic",
			modelId: "model",
			errorType: PROVIDER_FAILURE_ERROR_TYPE.TASK_INIT,
			failurePhase: PROVIDER_FAILURE_PHASE.PREFLIGHT,
		})
		expect(state.task?.taskId).toEqual(expect.any(String))
		expect(options.messages.appendAndEmit).toHaveBeenCalledWith(
			[
				expect.objectContaining({
					type: "say",
					say: "error",
					text: expect.stringContaining("No model configured for provider openai"),
				}),
			],
			{ type: "status", payload: { sessionId: state.task?.taskId, status: "error" } },
		)
		// One early post before session startup, one after the failure.
		expect(options.postStateToWebview).toHaveBeenCalledTimes(2)
	})

	it.each([true, false])("forwards task useAutoCondense=%s into SDK session config inputs", async (useAutoCondense) => {
		const { coordinator, options } = makeCoordinator()
		const taskSettings = { useAutoCondense }

		await coordinator.initTask("hello", undefined, undefined, undefined, taskSettings)

		expect(options.sessionConfigBuilder.build).toHaveBeenCalledWith(
			expect.objectContaining({
				taskSettings,
			}),
		)
		expect(options.buildStartSessionInput).toHaveBeenCalledWith(
			expect.any(Object),
			expect.objectContaining({
				taskSettings,
			}),
		)
	})

	it("reinitializes an existing task with preserved initial messages", async () => {
		vi.mocked(isDirectory).mockResolvedValue(true)
		const historyItem: HistoryItem = {
			id: "task-1",
			task: "old task",
			ts: 1,
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
			cwdOnTaskInitialization: "/task-cwd",
		}
		const { coordinator, options, state, tempHost } = makeCoordinator({ historyItem })

		await coordinator.reinitExistingTaskFromId("task-1")

		expect(options.clearTask).toHaveBeenCalledOnce()
		expect(options.taskHistory.findHistoryItem).toHaveBeenCalledWith("task-1")
		expect(isDirectory).toHaveBeenCalledWith("/task-cwd")
		expect(options.getWorkspaceRoot).not.toHaveBeenCalled()
		expect(options.sessionConfigBuilder.build).toHaveBeenCalledWith({ cwd: "/task-cwd", mode: "act", apiSelection: {} })
		expect(options.createTempSessionHost).toHaveBeenCalledOnce()
		expect(options.loadInitialMessages).toHaveBeenCalledWith(tempHost, "task-1")
		expect(tempHost.dispose).toHaveBeenCalledWith("readMessages")
		expect(options.sessions.startNewSession).toHaveBeenCalledWith({
			config: expect.objectContaining({ providerId: "anthropic", modelId: "model" }),
			interactive: true,
			initialMessages: [{ role: "user", content: "hello" }],
			sessionMetadata: expect.objectContaining({
				title: "old task",
				modelId: "model",
			}),
		})
		expect(state.task?.taskId).toBe("session-123")
		expect(options.postStateToWebview).toHaveBeenCalledOnce()
	})

	it("falls back to the workspace root when a stored task cwd is unavailable", async () => {
		const historyItem: HistoryItem = {
			id: "task-1",
			task: "old task",
			ts: 1,
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
			cwdOnTaskInitialization: "/missing-task-cwd",
		}
		const { coordinator, options } = makeCoordinator({ historyItem })

		await coordinator.reinitExistingTaskFromId("task-1")

		expect(isDirectory).toHaveBeenCalledWith("/missing-task-cwd")
		expect(options.getWorkspaceRoot).toHaveBeenCalledOnce()
		expect(options.sessionConfigBuilder.build).toHaveBeenCalledWith({ cwd: "/workspace", mode: "act", apiSelection: {} })
	})

	it("emits Cline auth errors when reinitialization fails due auth", async () => {
		const { coordinator, options } = makeCoordinator()
		options.sessionConfigBuilder.build.mockRejectedValue(new Error("missing api key"))
		options.isClineManagedProviderActive.mockReturnValue(true)

		await coordinator.reinitExistingTaskFromId("task-1")

		expect(options.emitClineAuthError).toHaveBeenCalledWith()
		expect(options.messages.emitSessionEvents).not.toHaveBeenCalled()
	})
})

function makeCoordinator(input: Partial<MakeCoordinatorInput> = {}) {
	const state: { task?: { taskId: string } } = {}
	const config = input.config ?? {
		providerId: "anthropic",
		modelId: "model",
		apiKey: "key",
	}
	const historyItem = input.historyItem ?? {
		id: "task-1",
		task: "old task",
		ts: 1,
		tokensIn: 0,
		tokensOut: 0,
		totalCost: 0,
	}
	const tempHost = {
		readMessages: vi.fn().mockResolvedValue([{ role: "user", content: "hello" }]),
		dispose: vi.fn().mockResolvedValue(undefined),
	}
	const sdkHost = {
		send: vi.fn(),
	}
	const options = {
		stateManager: {
			getGlobalSettingsKey: vi.fn(() => input.mode ?? "act"),
			getGlobalStateKey: vi.fn(() => undefined),
			getApiConfiguration: vi.fn(() => ({})),
		} as unknown as StateManager,
		sessions: {
			startNewSession: vi.fn((startInput?: { config?: { sessionId?: string } }) => ({
				startResult: { sessionId: startInput?.config?.sessionId ?? "session-123" },
				sdkHost,
			})),
			fireAndForgetSend: vi.fn(),
		},
		messages: {
			appendAndEmit: vi.fn(),
			emitSessionEvents: vi.fn(),
		},
		taskHistory: {
			findHistoryItem: vi.fn(() => (input.hasHistoryItem === false ? undefined : historyItem)),
			updateTaskHistory: vi.fn().mockResolvedValue([]),
			updateTaskHistoryItem: vi.fn().mockResolvedValue(undefined),
		},
		sessionConfigBuilder: {
			build: vi.fn().mockResolvedValue(config),
		},
		buildStartSessionInput: vi.fn((startConfig, startInput) => ({
			config: startConfig,
			interactive: true,
			prompt: startInput.prompt,
		})),
		createHistoryItemFromSession: vi.fn((sessionId, task, modelId, cwd) => ({
			id: sessionId,
			task,
			ts: 1,
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
			modelId,
			cwdOnTaskInitialization: cwd,
		})),
		clearTask: vi.fn().mockResolvedValue(undefined),
		setTask: vi.fn((task) => {
			state.task = task as { taskId: string } | undefined
		}),
		onAskResponse: vi.fn().mockResolvedValue(undefined),
		onCancelTask: vi.fn().mockResolvedValue(undefined),
		getWorkspaceRoot: vi.fn().mockResolvedValue("/workspace"),
		createTempSessionHost: vi.fn().mockResolvedValue(tempHost),
		loadInitialMessages: vi.fn().mockResolvedValue([{ role: "user", content: "hello" }]),
		resolveContextMentions: vi.fn(async (text: string) => `resolved: ${text}`),
		isClineManagedProviderActive: vi.fn(() => false),
		emitClineAuthError: vi.fn(),
		captureProviderApiError: vi.fn(),
		postStateToWebview: vi.fn().mockResolvedValue(undefined),
	} as unknown as SdkTaskStartCoordinatorOptions & {
		sessions: SdkTaskStartCoordinatorOptions["sessions"] & {
			startNewSession: ReturnType<typeof vi.fn>
			fireAndForgetSend: ReturnType<typeof vi.fn>
		}
		messages: SdkTaskStartCoordinatorOptions["messages"] & {
			appendAndEmit: ReturnType<typeof vi.fn>
			emitSessionEvents: ReturnType<typeof vi.fn>
		}
		taskHistory: SdkTaskStartCoordinatorOptions["taskHistory"] & {
			findHistoryItem: ReturnType<typeof vi.fn>
			updateTaskHistory: ReturnType<typeof vi.fn>
			updateTaskHistoryItem: ReturnType<typeof vi.fn>
		}
		sessionConfigBuilder: SdkTaskStartCoordinatorOptions["sessionConfigBuilder"] & { build: ReturnType<typeof vi.fn> }
		buildStartSessionInput: ReturnType<typeof vi.fn>
		createHistoryItemFromSession: ReturnType<typeof vi.fn>
		clearTask: ReturnType<typeof vi.fn>
		createTempSessionHost: ReturnType<typeof vi.fn>
		loadInitialMessages: ReturnType<typeof vi.fn>
		resolveContextMentions: ReturnType<typeof vi.fn>
		isClineManagedProviderActive: ReturnType<typeof vi.fn>
		emitClineAuthError: ReturnType<typeof vi.fn>
		captureProviderApiError: ReturnType<typeof vi.fn>
		postStateToWebview: ReturnType<typeof vi.fn>
	}

	return {
		coordinator: new SdkTaskStartCoordinator(options),
		options,
		state,
		tempHost,
	}
}

interface MakeCoordinatorInput {
	mode: "act" | "plan"
	config: {
		providerId: string
		modelId: string
		apiKey: string
	}
	historyItem: HistoryItem
	hasHistoryItem: boolean
}
