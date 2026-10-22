import type { ClineMessage, TurnState } from "@shared/ExtensionMessage"
import { act, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

// --- Mocks -------------------------------------------------------------------
// gRPC clients: record which RPC the send path chose.
const newTask = vi.fn().mockResolvedValue(undefined)
const askResponse = vi.fn().mockResolvedValue(undefined)
const cancelBackgroundCommand = vi.fn().mockResolvedValue(undefined)
const cancelTask = vi.fn().mockResolvedValue(undefined)
const clearTask = vi.fn().mockResolvedValue(undefined)
const condense = vi.fn().mockResolvedValue(undefined)
const trackIntent = vi.fn().mockResolvedValue(undefined)
const togglePlanActModeProto = vi.fn().mockResolvedValue({ value: false })
const interjectPrompt = vi.fn().mockResolvedValue(undefined)
const forkTaskAt = vi.fn().mockResolvedValue({ value: "aside-1" })
const showTaskWithId = vi.fn().mockResolvedValue(undefined)

vi.mock("@/services/grpc-client", () => ({
	TaskServiceClient: {
		newTask: (req: unknown) => newTask(req),
		askResponse: (req: unknown) => askResponse(req),
		cancelBackgroundCommand: (req: unknown) => cancelBackgroundCommand(req),
		cancelTask: (req: unknown) => cancelTask(req),
		clearTask: (req: unknown) => clearTask(req),
		interjectPrompt: (req: unknown) => interjectPrompt(req),
		forkTaskAt: (req: unknown) => forkTaskAt(req),
		showTaskWithId: (req: unknown) => showTaskWithId(req),
	},
	SlashServiceClient: {
		condense: (req: unknown) => condense(req),
		reportBug: vi.fn().mockResolvedValue(undefined),
	},
	StateServiceClient: {
		togglePlanActModeProto: (req: unknown) => togglePlanActModeProto(req),
	},
	UiServiceClient: {
		trackIntent: (req: unknown) => trackIntent(req),
	},
}))

// Proto request factories just echo their input so we can assert on it.
vi.mock("@shared/proto/cline/task", () => ({
	AskResponseRequest: { create: (x: unknown) => x },
	NewTaskRequest: { create: (x: unknown) => x },
	InterjectPromptRequest: { create: (x: unknown) => x },
	ForkTaskAtRequest: { create: (x: unknown) => x },
}))
vi.mock("@shared/proto/cline/state", () => ({
	PlanActMode: { PLAN: 0, ACT: 1 },
	TogglePlanActModeRequest: { create: (x: unknown) => x },
}))
vi.mock("@shared/proto/cline/ui", () => ({
	IntentEvent: { create: (x: unknown) => x },
}))
vi.mock("@shared/proto/cline/common", () => ({
	EmptyRequest: { create: (x: unknown) => x },
	StringRequest: { create: (x: unknown) => x },
	ComposerProvenance: { create: (x: unknown) => x },
	ScriptInvocation: { create: (x: unknown) => x },
	MessageLinkRef: { create: (x: unknown) => x },
}))

// useExtensionState supplies turnState (+ backgroundCommandRunning, mode) to the hook.
let mockTurnState: TurnState | undefined
let mockMode: "plan" | "act" = "act"
vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({
		backgroundCommandRunning: false,
		turnState: mockTurnState,
		mode: mockMode,
	}),
}))

import { getComposerTaskGroup, setComposerPageTaskGroup, setComposerTaskGroup } from "@/components/taskGroup/composerTaskGroup"
import type { ChatState } from "../types/chatTypes"
import { useChatState } from "./useChatState"
import { useMessageHandlers } from "./useMessageHandlers"

// Minimal ChatState stub. clineAsk/lastMessage are the only derived values the send path reads.
function makeChatState(messages: ClineMessage[], overrides: Partial<ChatState> = {}): ChatState {
	const last = messages.at(-1)
	const state = {
		inputValue: "",
		setInputValue: vi.fn(),
		quotes: [],
		setQuotes: vi.fn(),
		messageTags: [],
		setMessageTags: vi.fn(),
		addQuote: vi.fn(),
		isTextAreaFocused: false,
		setIsTextAreaFocused: vi.fn(),
		selectedImages: [],
		setSelectedImages: vi.fn(),
		selectedFiles: [],
		setSelectedFiles: vi.fn(),
		getDraftSnapshot: vi.fn(() => ({ revision: 0, text: "", quotes: [], images: [], files: [], authorizedThreadIds: [] })),
		authorizeThread: vi.fn(),
		setScriptRun: vi.fn(),
		restoreAuthorization: vi.fn(),
		consumeDraftSnapshot: vi.fn(),
		sendingDisabled: false,
		setSendingDisabled: vi.fn(),
		enableButtons: false,
		setEnableButtons: vi.fn(),
		primaryButtonText: undefined,
		setPrimaryButtonText: vi.fn(),
		secondaryButtonText: undefined,
		setSecondaryButtonText: vi.fn(),
		expandedRows: {},
		setExpandedRows: vi.fn(),
		pendingUserMessage: undefined,
		setPendingUserMessage: vi.fn(),
		pendingResponse: undefined,
		setPendingResponse: vi.fn(),
		textAreaRef: { current: null },
		lastMessage: last,
		secondLastMessage: messages.at(-2),
		clineAsk: last?.type === "ask" ? last.ask : undefined,
		task: messages.at(0),
		handleFocusChange: vi.fn(),
		clearExpandedRows: vi.fn(),
		resetState: vi.fn(),
	} as unknown as ChatState
	return { ...state, ...overrides } as ChatState
}

const completedConversation: ClineMessage[] = [
	{ ts: 1, type: "say", say: "text", text: "task" },
	{ ts: 2, type: "say", say: "completion_result", text: "all done" },
]

describe("useMessageHandlers — send routing", () => {
	beforeEach(() => {
		newTask.mockReset()
		newTask.mockResolvedValue(undefined)
		askResponse.mockReset()
		askResponse.mockResolvedValue(undefined)
		cancelBackgroundCommand.mockReset()
		cancelBackgroundCommand.mockResolvedValue(undefined)
		cancelTask.mockReset()
		cancelTask.mockResolvedValue(undefined)
		clearTask.mockReset()
		clearTask.mockResolvedValue(undefined)
		condense.mockReset()
		condense.mockResolvedValue(undefined)
		trackIntent.mockReset()
		trackIntent.mockResolvedValue(undefined)
		togglePlanActModeProto.mockReset()
		togglePlanActModeProto.mockResolvedValue({ value: false })
		mockTurnState = undefined
		mockMode = "act"
	})

	it("routes /compact to the condense RPC instead of sending it as a message", async () => {
		mockTurnState = { phase: "completed", seq: 7 }
		const { result } = renderHook(() => useMessageHandlers(completedConversation, makeChatState(completedConversation)))

		await act(async () => {
			await result.current.handleSendMessage("/compact", [], [])
		})

		expect(condense).toHaveBeenCalledTimes(1)
		expect(condense).toHaveBeenCalledWith(expect.objectContaining({ value: "compact" }))
		expect(newTask).not.toHaveBeenCalled()
		expect(askResponse).not.toHaveBeenCalled()
		expect(trackIntent).not.toHaveBeenCalled()
	})

	it("routes the /smol alias to the condense RPC as well", async () => {
		mockTurnState = { phase: "completed", seq: 7 }
		const { result } = renderHook(() => useMessageHandlers(completedConversation, makeChatState(completedConversation)))

		await act(async () => {
			await result.current.handleSendMessage("/smol", [], [])
		})

		expect(condense).toHaveBeenCalledTimes(1)
		expect(newTask).not.toHaveBeenCalled()
		expect(askResponse).not.toHaveBeenCalled()
		expect(trackIntent).not.toHaveBeenCalled()
	})

	it("routes the /newtask alias to the condense RPC as well", async () => {
		mockTurnState = { phase: "completed", seq: 7 }
		const { result } = renderHook(() => useMessageHandlers(completedConversation, makeChatState(completedConversation)))

		await act(async () => {
			await result.current.handleSendMessage("/newtask", [], [])
		})

		expect(condense).toHaveBeenCalledTimes(1)
		expect(condense).toHaveBeenCalledWith(expect.objectContaining({ value: "compact" }))
		expect(newTask).not.toHaveBeenCalled()
		expect(askResponse).not.toHaveBeenCalled()
		expect(trackIntent).not.toHaveBeenCalled()
	})

	it("does not intercept /compact when there is no active task (starts a new task instead)", async () => {
		mockTurnState = { phase: "idle", seq: 1 }
		const { result } = renderHook(() => useMessageHandlers([], makeChatState([])))

		await act(async () => {
			await result.current.handleSendMessage("/compact", [], [])
		})

		expect(condense).not.toHaveBeenCalled()
		expect(newTask).toHaveBeenCalledTimes(1)
		expect(trackIntent).toHaveBeenCalledWith(
			expect.objectContaining({
				action: "prompt_submitted",
				source: "chat_submit",
				hasText: true,
				hasImages: false,
				hasFiles: false,
				hasActiveTask: false,
				textLength: "/compact".length,
			}),
		)
	})

	it("routes a bare /act to the mode toggle RPC without sending a message", async () => {
		mockMode = "plan"
		mockTurnState = { phase: "completed", seq: 7 }
		const { result } = renderHook(() => useMessageHandlers(completedConversation, makeChatState(completedConversation)))

		await act(async () => {
			await result.current.handleSendMessage("/act", [], [])
		})

		expect(togglePlanActModeProto).toHaveBeenCalledTimes(1)
		expect(togglePlanActModeProto).toHaveBeenCalledWith(
			expect.objectContaining({ mode: 1, chatContent: expect.objectContaining({ message: undefined }) }),
		)
		expect(newTask).not.toHaveBeenCalled()
		expect(askResponse).not.toHaveBeenCalled()
		expect(condense).not.toHaveBeenCalled()
	})

	it("routes a bare /ask to the mode toggle RPC with PLAN mode", async () => {
		mockTurnState = { phase: "completed", seq: 7 }
		const { result } = renderHook(() => useMessageHandlers(completedConversation, makeChatState(completedConversation)))

		await act(async () => {
			await result.current.handleSendMessage("/ask", [], [])
		})

		expect(togglePlanActModeProto).toHaveBeenCalledWith(expect.objectContaining({ mode: 0 }))
		expect(newTask).not.toHaveBeenCalled()
		expect(askResponse).not.toHaveBeenCalled()
	})

	it("sends text after /act via the toggle's chatContent so the host can consume it", async () => {
		mockMode = "plan"
		mockTurnState = { phase: "awaiting_followup", seq: 7 }
		togglePlanActModeProto.mockResolvedValue({ value: true })
		const setInputValue = vi.fn()
		const { result } = renderHook(() =>
			useMessageHandlers(completedConversation, makeChatState(completedConversation, { setInputValue })),
		)

		await act(async () => {
			await result.current.handleSendMessage("/act build it", [], [])
		})

		expect(togglePlanActModeProto).toHaveBeenCalledWith(
			expect.objectContaining({ mode: 1, chatContent: expect.objectContaining({ message: "build it" }) }),
		)
		// Host consumed the message as the mode-switch continuation — nothing is sent again.
		expect(askResponse).not.toHaveBeenCalled()
		expect(newTask).not.toHaveBeenCalled()
		expect(setInputValue).toHaveBeenCalledWith("")
	})

	it("sends the text as a normal follow-up when the mode switch does not consume it", async () => {
		mockMode = "plan"
		mockTurnState = { phase: "completed", seq: 7 }
		const { result } = renderHook(() => useMessageHandlers(completedConversation, makeChatState(completedConversation)))

		await act(async () => {
			await result.current.handleSendMessage("/act build it", [], [])
		})

		expect(togglePlanActModeProto).toHaveBeenCalledWith(
			expect.objectContaining({ mode: 1, chatContent: expect.objectContaining({ message: "build it" }) }),
		)
		expect(askResponse).toHaveBeenCalledWith(expect.objectContaining({ responseType: "messageResponse", text: "build it" }))
		expect(askResponse).not.toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining("/act") }))
	})

	it("starts a new task in Ask mode from the welcome screen with /ask <text>", async () => {
		mockMode = "act"
		mockTurnState = { phase: "idle", seq: 1 }
		const { result } = renderHook(() => useMessageHandlers([], makeChatState([])))

		await act(async () => {
			await result.current.handleSendMessage("/ask think about caching", [], [])
		})

		expect(togglePlanActModeProto).toHaveBeenCalledWith(expect.objectContaining({ mode: 0 }))
		expect(newTask).toHaveBeenCalledWith(expect.objectContaining({ text: "think about caching" }))
	})

	it("sends text after /act normally when already in act mode", async () => {
		mockMode = "act"
		mockTurnState = { phase: "completed", seq: 7 }
		const { result } = renderHook(() => useMessageHandlers(completedConversation, makeChatState(completedConversation)))

		await act(async () => {
			await result.current.handleSendMessage("/act ship it", [], [])
		})

		expect(togglePlanActModeProto).not.toHaveBeenCalled()
		expect(askResponse).toHaveBeenCalledWith(expect.objectContaining({ responseType: "messageResponse", text: "ship it" }))
	})

	it("is a no-op for a bare /act when already in act mode", async () => {
		mockMode = "act"
		mockTurnState = { phase: "completed", seq: 7 }
		const setInputValue = vi.fn()
		const { result } = renderHook(() =>
			useMessageHandlers(completedConversation, makeChatState(completedConversation, { setInputValue })),
		)

		await act(async () => {
			await result.current.handleSendMessage("/act", [], [])
		})

		expect(togglePlanActModeProto).not.toHaveBeenCalled()
		expect(askResponse).not.toHaveBeenCalled()
		expect(newTask).not.toHaveBeenCalled()
		expect(setInputValue).toHaveBeenCalledWith("")
	})

	it("does not treat /activity as a mode command", async () => {
		mockMode = "act"
		mockTurnState = { phase: "completed", seq: 7 }
		const { result } = renderHook(() => useMessageHandlers(completedConversation, makeChatState(completedConversation)))

		await act(async () => {
			await result.current.handleSendMessage("/activity is fine", [], [])
		})

		expect(togglePlanActModeProto).not.toHaveBeenCalled()
		expect(askResponse).toHaveBeenCalledWith(
			expect.objectContaining({ responseType: "messageResponse", text: "/activity is fine" }),
		)
	})

	it("after a completed turn (no clineAsk), Enter continues the conversation via askResponse — NOT newTask", async () => {
		mockTurnState = { phase: "completed", seq: 7 }
		const { result } = renderHook(() => useMessageHandlers(completedConversation, makeChatState(completedConversation)))

		await act(async () => {
			await result.current.handleSendMessage("another question", [], [])
		})

		expect(newTask).not.toHaveBeenCalled()
		expect(askResponse).toHaveBeenCalledTimes(1)
		expect(askResponse).toHaveBeenCalledWith(
			expect.objectContaining({ responseType: "messageResponse", text: "another question" }),
		)
		expect(trackIntent).toHaveBeenCalledWith(
			expect.objectContaining({
				action: "prompt_submitted",
				source: "chat_submit",
				hasText: true,
				hasImages: false,
				hasFiles: false,
				hasActiveTask: true,
				textLength: "another question".length,
			}),
		)
	})

	it("shows pending composer state before a follow-up askResponse resolves", async () => {
		mockTurnState = { phase: "completed", seq: 7 }
		let resolveAskResponse: () => void = () => {}
		askResponse.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					resolveAskResponse = resolve
				}),
		)
		const setInputValue = vi.fn()
		const setQuotes = vi.fn()
		const setSendingDisabled = vi.fn()
		const setSelectedImages = vi.fn()
		const setSelectedFiles = vi.fn()
		const setEnableButtons = vi.fn()
		const setPendingUserMessage = vi.fn()
		const setPendingResponse = vi.fn()
		const chatState = makeChatState(completedConversation, {
			quotes: [{ text: "selected context", note: "" }],
			sendingDisabled: false,
			enableButtons: true,
			setInputValue,
			setQuotes,
			setSendingDisabled,
			setSelectedImages,
			setSelectedFiles,
			setEnableButtons,
			setPendingUserMessage,
			setPendingResponse,
		})
		const { result } = renderHook(() => useMessageHandlers(completedConversation, chatState))

		let sendPromise: Promise<void> = Promise.resolve()
		await act(async () => {
			sendPromise = result.current.handleSendMessage("another question", ["image.png"], ["a.ts"])
			await Promise.resolve()
		})

		expect(askResponse).toHaveBeenCalledWith(
			expect.objectContaining({
				responseType: "messageResponse",
				text: expect.stringContaining("another question"),
				images: ["image.png"],
				files: ["a.ts"],
			}),
		)
		expect(setInputValue).toHaveBeenCalledWith("")
		expect(setQuotes).toHaveBeenCalledWith([])
		expect(setSendingDisabled).toHaveBeenCalledWith(true)
		expect(setSelectedImages).toHaveBeenCalledWith([])
		expect(setSelectedFiles).toHaveBeenCalledWith([])
		expect(setEnableButtons).toHaveBeenCalledWith(false)
		expect(setPendingUserMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				afterTs: 2,
				message: expect.objectContaining({
					type: "say",
					say: "user_feedback",
					text: expect.stringContaining("another question"),
					images: ["image.png"],
					files: ["a.ts"],
					partial: false,
				}),
			}),
		)
		expect(setPendingResponse).toHaveBeenCalledWith({
			id: 1,
			turnStateSeq: 7,
			messageCount: completedConversation.length,
		})

		await act(async () => {
			resolveAskResponse()
			await sendPromise
		})
	})

	it("restores pending follow-up UI state when askResponse fails", async () => {
		mockTurnState = { phase: "completed", seq: 7 }
		const error = new Error("transport down")
		const setInputValue = vi.fn()
		const setQuotes = vi.fn()
		const setSendingDisabled = vi.fn()
		const setSelectedImages = vi.fn()
		const setSelectedFiles = vi.fn()
		const setEnableButtons = vi.fn()
		const setPendingUserMessage = vi.fn()
		const setPendingResponse = vi.fn()
		const chatState = makeChatState(completedConversation, {
			quotes: [{ text: "selected context", note: "" }],
			sendingDisabled: false,
			enableButtons: true,
			setInputValue,
			setQuotes,
			setSendingDisabled,
			setSelectedImages,
			setSelectedFiles,
			setEnableButtons,
			setPendingUserMessage,
			setPendingResponse,
		})
		const { result } = renderHook(() => useMessageHandlers(completedConversation, chatState))
		askResponse.mockRejectedValueOnce(error)

		let caught: unknown
		await act(async () => {
			try {
				await result.current.handleSendMessage("another question", ["image.png"], ["a.ts"])
			} catch (err) {
				caught = err
			}
		})

		expect(caught).toBe(error)
		expect(setInputValue).toHaveBeenNthCalledWith(1, "")
		expect(setInputValue).toHaveBeenLastCalledWith("another question")
		expect(setQuotes).toHaveBeenNthCalledWith(1, [])
		expect(setQuotes).toHaveBeenLastCalledWith([{ text: "selected context", note: "" }])
		expect(setSendingDisabled).toHaveBeenNthCalledWith(1, true)
		expect(setSendingDisabled).toHaveBeenLastCalledWith(false)
		expect(setSelectedImages).toHaveBeenNthCalledWith(1, [])
		expect(setSelectedImages).toHaveBeenLastCalledWith(["image.png"])
		expect(setSelectedFiles).toHaveBeenNthCalledWith(1, [])
		expect(setSelectedFiles).toHaveBeenLastCalledWith(["a.ts"])
		expect(setEnableButtons).toHaveBeenNthCalledWith(1, false)
		expect(setEnableButtons).toHaveBeenLastCalledWith(true)
		expect(setPendingUserMessage).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				afterTs: 2,
				message: expect.objectContaining({
					type: "say",
					say: "user_feedback",
					text: expect.stringContaining("another question"),
				}),
			}),
		)
		const optimisticMessage = setPendingUserMessage.mock.calls[0][0]
		const rollbackMessage = setPendingUserMessage.mock.calls.at(-1)?.[0]
		expect(rollbackMessage(optimisticMessage)).toBeUndefined()
		const newerMessage = { afterTs: 3, message: { ...optimisticMessage.message, ts: 4 } }
		expect(rollbackMessage(newerMessage)).toBe(newerMessage)
		const pendingResponse = setPendingResponse.mock.calls[0][0]
		const rollbackResponse = setPendingResponse.mock.calls.at(-1)?.[0]
		expect(rollbackResponse(pendingResponse)).toBeUndefined()
		const newerResponse = { ...pendingResponse, id: 2 }
		expect(rollbackResponse(newerResponse)).toBe(newerResponse)
	})

	it("shows a pending chat bubble immediately when sending a message to a task resumed from history", async () => {
		mockTurnState = { phase: "resumable", seq: 5 }
		const historyConversation: ClineMessage[] = [
			{ ts: 1, type: "say", say: "task", text: "task" },
			{ ts: 2, type: "say", say: "text", text: "partial work" },
			{ ts: 3, type: "ask", ask: "resume_task" },
		]
		const setPendingUserMessage = vi.fn()
		const setPendingResponse = vi.fn()
		const { result } = renderHook(() =>
			useMessageHandlers(
				historyConversation,
				makeChatState(historyConversation, { setPendingUserMessage, setPendingResponse }),
			),
		)

		await act(async () => {
			await result.current.handleSendMessage("keep going", ["image.png"], ["a.ts"])
		})

		expect(newTask).not.toHaveBeenCalled()
		expect(askResponse).toHaveBeenCalledTimes(1)
		expect(askResponse).toHaveBeenCalledWith(
			expect.objectContaining({
				responseType: "yesButtonClicked",
				text: "keep going",
				images: ["image.png"],
				files: ["a.ts"],
			}),
		)
		expect(setPendingUserMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				afterTs: 3,
				message: expect.objectContaining({
					type: "say",
					say: "user_feedback",
					text: "keep going",
					images: ["image.png"],
					files: ["a.ts"],
					partial: false,
				}),
			}),
		)
		expect(setPendingResponse).toHaveBeenCalledWith({
			id: 1,
			turnStateSeq: 5,
			messageCount: historyConversation.length,
		})
	})

	it("shows a pending chat bubble when resuming a completed task from history", async () => {
		mockTurnState = { phase: "completed", seq: 4 }
		const historyConversation: ClineMessage[] = [
			{ ts: 1, type: "say", say: "task", text: "task" },
			{ ts: 2, type: "say", say: "completion_result", text: "all done" },
			{ ts: 3, type: "ask", ask: "resume_completed_task" },
		]
		const setPendingUserMessage = vi.fn()
		const { result } = renderHook(() =>
			useMessageHandlers(historyConversation, makeChatState(historyConversation, { setPendingUserMessage })),
		)

		await act(async () => {
			await result.current.handleSendMessage("one more thing", [], [])
		})

		expect(askResponse).toHaveBeenCalledWith(
			expect.objectContaining({ responseType: "yesButtonClicked", text: "one more thing" }),
		)
		expect(setPendingUserMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				afterTs: 3,
				message: expect.objectContaining({ say: "user_feedback", text: "one more thing" }),
			}),
		)
	})

	it("does not show a pending chat bubble for a streaming follow-up that will be queued", async () => {
		mockTurnState = { phase: "streaming", seq: 9 }
		const streamingConversation: ClineMessage[] = [
			{ ts: 1, type: "say", say: "task", text: "task" },
			{ ts: 2, type: "say", say: "text", text: "working", partial: true },
		]
		const setPendingUserMessage = vi.fn()
		const setPendingResponse = vi.fn()
		const { result } = renderHook(() =>
			useMessageHandlers(
				streamingConversation,
				makeChatState(streamingConversation, { setPendingUserMessage, setPendingResponse }),
			),
		)

		await act(async () => {
			await result.current.handleSendMessage("steer this way", [], [])
		})

		expect(askResponse).toHaveBeenCalledTimes(1)
		expect(setPendingUserMessage).not.toHaveBeenCalled()
		expect(setPendingResponse).not.toHaveBeenCalled()
	})

	it("rejects a pending approval when the composer is submitted with typed feedback", async () => {
		mockTurnState = { phase: "awaiting_approval", anchorTs: 2, seq: 9 }
		const approvalConversation: ClineMessage[] = [
			{ ts: 1, type: "say", say: "task", text: "task" },
			{ ts: 2, type: "ask", ask: "tool", text: JSON.stringify({ tool: "newFileCreated", path: "notes.txt" }) },
		]
		const setPendingUserMessage = vi.fn()
		const { result } = renderHook(() =>
			useMessageHandlers(approvalConversation, makeChatState(approvalConversation, { setPendingUserMessage })),
		)

		await act(async () => {
			await result.current.handleSendMessage("use a different filename", ["image.png"], ["notes.txt"])
		})

		expect(newTask).not.toHaveBeenCalled()
		expect(condense).not.toHaveBeenCalled()
		expect(askResponse).toHaveBeenCalledTimes(1)
		expect(askResponse).toHaveBeenCalledWith(
			expect.objectContaining({
				responseType: "noButtonClicked",
				text: "use a different filename",
				images: ["image.png"],
				files: ["notes.txt"],
			}),
		)
		expect(askResponse).not.toHaveBeenCalledWith(expect.objectContaining({ responseType: "messageResponse" }))
		expect(setPendingUserMessage).not.toHaveBeenCalled()
	})

	it("phase awaiting_followup also routes a follow-up to askResponse", async () => {
		mockTurnState = { phase: "awaiting_followup", seq: 3 }
		const setPendingResponse = vi.fn()
		const { result } = renderHook(() =>
			useMessageHandlers(completedConversation, makeChatState(completedConversation, { setPendingResponse })),
		)

		await act(async () => {
			await result.current.handleSendMessage("more info", [], [])
		})

		expect(newTask).not.toHaveBeenCalled()
		expect(askResponse).toHaveBeenCalledTimes(1)
		expect(setPendingResponse).toHaveBeenCalledWith({
			id: 1,
			turnStateSeq: 3,
			messageCount: completedConversation.length,
		})
	})

	it("submits a new prompt instead of retrying the failed prompt from the error state", async () => {
		mockTurnState = { phase: "error", anchorTs: 2, seq: 4 }
		const failedConversation: ClineMessage[] = [
			{ ts: 1, type: "say", say: "task", text: "task" },
			{ ts: 2, type: "ask", ask: "api_req_failed", text: "provider unavailable" },
		]
		const setPendingUserMessage = vi.fn()
		const consumeDraftSnapshot = vi.fn()
		const draft = {
			revision: 4,
			text: "try a different approach",
			quotes: [],
			images: ["image.png"],
			files: ["notes.txt"],
			authorizedThreadIds: [],
		}
		const { result } = renderHook(() =>
			useMessageHandlers(
				failedConversation,
				makeChatState(failedConversation, {
					consumeDraftSnapshot,
					getDraftSnapshot: () => draft,
					setPendingUserMessage,
				}),
			),
		)

		await act(async () => {
			await result.current.handleSendMessage("try a different approach", ["image.png"], ["notes.txt"])
		})

		expect(askResponse).toHaveBeenCalledTimes(1)
		expect(askResponse).toHaveBeenCalledWith({
			responseType: "messageResponse",
			text: "try a different approach",
			provenance: undefined,
			images: ["image.png"],
			files: ["notes.txt"],
		})
		expect(askResponse).not.toHaveBeenCalledWith(expect.objectContaining({ responseType: "yesButtonClicked" }))
		expect(setPendingUserMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				afterTs: 2,
				message: expect.objectContaining({ say: "user_feedback", text: "try a different approach" }),
			}),
		)
		expect(consumeDraftSnapshot).toHaveBeenCalledWith(draft)
	})

	it("lets the first recovery action claim the failed turn", async () => {
		mockTurnState = { phase: "error", anchorTs: 2, seq: 4 }
		const failedConversation: ClineMessage[] = [
			{ ts: 1, type: "say", say: "task", text: "task" },
			{ ts: 2, type: "ask", ask: "api_req_failed", text: "provider unavailable" },
		]
		let resolveAskResponse: () => void = () => {}
		askResponse.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					resolveAskResponse = resolve
				}),
		)
		const { result } = renderHook(() => {
			const chatState = useChatState(failedConversation)
			return { chatState, handlers: useMessageHandlers(failedConversation, chatState) }
		})
		act(() => result.current.chatState.setInputValue("try a different approach"))

		let sendPromise: Promise<void> = Promise.resolve()
		await act(async () => {
			sendPromise = result.current.handlers.handleSendMessage("try a different approach", [], [])
			await Promise.resolve()
		})
		expect(result.current.handlers.recoveryActionInFlight).toBe(true)

		await act(async () => {
			await result.current.handlers.executeButtonAction({ type: "retry" })
		})
		expect(askResponse).toHaveBeenCalledTimes(1)
		expect(askResponse).toHaveBeenCalledWith(
			expect.objectContaining({ responseType: "messageResponse", text: "try a different approach" }),
		)

		await act(async () => {
			resolveAskResponse()
			await sendPromise
		})
	})

	it("uses the anchored API error when a status message trails it", async () => {
		mockTurnState = { phase: "error", anchorTs: 2, seq: 4 }
		const failedConversation: ClineMessage[] = [
			{ ts: 1, type: "say", say: "task", text: "task" },
			{ ts: 2, type: "ask", ask: "api_req_failed", text: "provider unavailable" },
			{ ts: 3, type: "say", say: "task_progress", text: "bookkeeping" },
		]
		let resolveAskResponse: () => void = () => {}
		askResponse.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					resolveAskResponse = resolve
				}),
		)
		const { result } = renderHook(() => {
			const chatState = useChatState(failedConversation)
			return { chatState, handlers: useMessageHandlers(failedConversation, chatState) }
		})
		act(() => result.current.chatState.setInputValue("try a different approach"))
		expect(result.current.handlers.errorRecoveryAvailable).toBe(true)

		let sendPromise: Promise<void> = Promise.resolve()
		await act(async () => {
			sendPromise = result.current.handlers.handleSendMessage("try a different approach", [], [])
			await Promise.resolve()
		})
		await act(async () => {
			await result.current.handlers.executeButtonAction({ type: "retry" })
		})

		expect(askResponse).toHaveBeenCalledTimes(1)
		expect(askResponse).toHaveBeenCalledWith(
			expect.objectContaining({ responseType: "messageResponse", text: "try a different approach" }),
		)
		await act(async () => {
			resolveAskResponse()
			await sendPromise
		})
	})

	it("blocks composer submission after Retry claims the failed turn", async () => {
		mockTurnState = { phase: "error", anchorTs: 2, seq: 4 }
		const failedConversation: ClineMessage[] = [
			{ ts: 1, type: "say", say: "task", text: "task" },
			{ ts: 2, type: "ask", ask: "api_req_failed", text: "provider unavailable" },
		]
		let resolveAskResponse: () => void = () => {}
		askResponse.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					resolveAskResponse = resolve
				}),
		)
		const { result } = renderHook(() => {
			const chatState = useChatState(failedConversation)
			return { chatState, handlers: useMessageHandlers(failedConversation, chatState) }
		})
		act(() => result.current.chatState.setInputValue("try a different approach"))

		let retryPromise: Promise<void> = Promise.resolve()
		await act(async () => {
			retryPromise = result.current.handlers.executeButtonAction({ type: "retry" })
			await Promise.resolve()
		})
		expect(result.current.handlers.recoveryActionInFlight).toBe(true)

		await act(async () => {
			await result.current.handlers.handleSendMessage("try a different approach", [], [])
		})
		expect(askResponse).toHaveBeenCalledTimes(1)
		expect(askResponse).toHaveBeenCalledWith({ responseType: "yesButtonClicked" })

		await act(async () => {
			resolveAskResponse()
			await retryPromise
		})
	})

	it("blocks composer submission after Start New Task claims the failed turn", async () => {
		mockTurnState = { phase: "error", anchorTs: 2, seq: 4 }
		const failedConversation: ClineMessage[] = [
			{ ts: 1, type: "say", say: "task", text: "task" },
			{ ts: 2, type: "ask", ask: "api_req_failed", text: "provider unavailable" },
		]
		let resolveClearTask: () => void = () => {}
		clearTask.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					resolveClearTask = resolve
				}),
		)
		const { result } = renderHook(() => {
			const chatState = useChatState(failedConversation)
			return { chatState, handlers: useMessageHandlers(failedConversation, chatState) }
		})
		act(() => result.current.chatState.setInputValue("try a different approach"))

		let newTaskPromise: Promise<void> = Promise.resolve()
		await act(async () => {
			newTaskPromise = result.current.handlers.executeButtonAction({ type: "new_task" })
			await Promise.resolve()
		})

		await act(async () => {
			await result.current.handlers.handleSendMessage("try a different approach", [], [])
		})
		expect(clearTask).toHaveBeenCalledTimes(1)
		expect(askResponse).not.toHaveBeenCalled()

		await act(async () => {
			resolveClearTask()
			await newTaskPromise
		})
	})

	it("rejects task compaction while API error recovery is available", async () => {
		mockTurnState = { phase: "error", anchorTs: 2, seq: 4 }
		const failedConversation: ClineMessage[] = [
			{ ts: 1, type: "say", say: "task", text: "task" },
			{ ts: 2, type: "ask", ask: "api_req_failed", text: "provider unavailable" },
		]
		const { result } = renderHook(() => useMessageHandlers(failedConversation, makeChatState(failedConversation)))

		await expect(result.current.compactTask()).resolves.toBe(false)

		expect(condense).not.toHaveBeenCalled()
	})

	it("keeps a typed /compact in the composer during API error recovery instead of sending it as text", async () => {
		mockTurnState = { phase: "error", anchorTs: 2, seq: 4 }
		const failedConversation: ClineMessage[] = [
			{ ts: 1, type: "say", say: "task", text: "task" },
			{ ts: 2, type: "ask", ask: "api_req_failed", text: "provider unavailable" },
		]
		const { result } = renderHook(() => {
			const chatState = useChatState(failedConversation)
			return { chatState, handlers: useMessageHandlers(failedConversation, chatState) }
		})
		act(() => result.current.chatState.setInputValue("/compact"))

		await act(async () => {
			await result.current.handlers.handleSendMessage("/compact", [], [])
		})

		expect(condense).not.toHaveBeenCalled()
		expect(askResponse).not.toHaveBeenCalled()
		expect(result.current.chatState.inputValue).toBe("/compact")
		expect(result.current.handlers.recoveryActionInFlight).toBe(false)
	})

	it("offers recovery for a provider failure that reaches the error phase without an anchor", async () => {
		mockTurnState = { phase: "error", seq: 4 }
		const failedConversation: ClineMessage[] = [
			{ ts: 1, type: "say", say: "task", text: "task" },
			{ ts: 2, type: "say", say: "error", text: "Agent error: provider unavailable" },
		]
		let resolveAskResponse: () => void = () => {}
		askResponse.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					resolveAskResponse = resolve
				}),
		)
		const { result } = renderHook(() => {
			const chatState = useChatState(failedConversation)
			return { chatState, handlers: useMessageHandlers(failedConversation, chatState) }
		})
		expect(result.current.handlers.errorRecoveryAvailable).toBe(true)
		act(() => result.current.chatState.setInputValue("try a different approach"))

		let sendPromise: Promise<void> = Promise.resolve()
		await act(async () => {
			sendPromise = result.current.handlers.handleSendMessage("try a different approach", [], [])
			await Promise.resolve()
		})
		expect(result.current.handlers.recoveryActionInFlight).toBe(true)

		await act(async () => {
			await expect(result.current.handlers.executeButtonAction({ type: "retry" })).resolves.toBe(false)
		})
		expect(askResponse).toHaveBeenCalledTimes(1)
		expect(askResponse).toHaveBeenCalledWith(
			expect.objectContaining({ responseType: "messageResponse", text: "try a different approach" }),
		)

		await act(async () => {
			resolveAskResponse()
			await sendPromise
		})
	})

	it("does not treat the mistake limit as API error recovery", () => {
		mockTurnState = { phase: "error", anchorTs: 2, seq: 4 }
		const conversation: ClineMessage[] = [
			{ ts: 1, type: "say", say: "task", text: "task" },
			{ ts: 2, type: "ask", ask: "mistake_limit_reached", text: "" },
		]
		const { result } = renderHook(() => useMessageHandlers(conversation, makeChatState(conversation)))

		expect(result.current.errorRecoveryAvailable).toBe(false)
	})

	it("reports that a duplicate cancellation did not start", async () => {
		mockTurnState = { phase: "streaming", seq: 4 }
		let resolveCancelTask: () => void = () => {}
		cancelTask.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					resolveCancelTask = resolve
				}),
		)
		const { result } = renderHook(() => useMessageHandlers(completedConversation, makeChatState(completedConversation)))

		let firstCancel: Promise<boolean> = Promise.resolve(false)
		await act(async () => {
			firstCancel = result.current.executeButtonAction({ type: "cancel" })
			await Promise.resolve()
		})

		await expect(result.current.executeButtonAction({ type: "cancel" })).resolves.toBe(false)
		expect(cancelTask).toHaveBeenCalledTimes(1)

		await act(async () => {
			resolveCancelTask()
			await expect(firstCancel).resolves.toBe(true)
		})
	})

	it("attributes a navbar new-task transition to the navbar", async () => {
		mockTurnState = { phase: "completed", seq: 4 }
		const { result } = renderHook(() => useMessageHandlers(completedConversation, makeChatState(completedConversation)))

		await act(async () => {
			await result.current.startNewTask("navbar")
		})

		expect(clearTask).toHaveBeenCalledTimes(1)
		expect(trackIntent).toHaveBeenCalledWith(expect.objectContaining({ action: "new_task_clicked", source: "navbar" }))
	})

	it("preserves edits made while a recovery response succeeds", async () => {
		mockTurnState = { phase: "error", anchorTs: 2, seq: 4 }
		const failedConversation: ClineMessage[] = [
			{ ts: 1, type: "say", say: "task", text: "task" },
			{ ts: 2, type: "ask", ask: "api_req_failed", text: "provider unavailable" },
		]
		let resolveAskResponse: () => void = () => {}
		askResponse.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					resolveAskResponse = resolve
				}),
		)
		const { result } = renderHook(() => {
			const chatState = useChatState(failedConversation)
			return { chatState, handlers: useMessageHandlers(failedConversation, chatState) }
		})
		act(() => result.current.chatState.setInputValue("submitted draft"))

		let sendPromise: Promise<void> = Promise.resolve()
		await act(async () => {
			sendPromise = result.current.handlers.handleSendMessage("submitted draft", [], [])
			await Promise.resolve()
		})
		act(() => {
			result.current.chatState.setInputValue("newer draft")
			result.current.chatState.setSelectedFiles(["newer.md"])
		})

		await act(async () => {
			resolveAskResponse()
			await sendPromise
		})
		expect(result.current.chatState.inputValue).toBe("newer draft")
		expect(result.current.chatState.selectedFiles).toEqual(["newer.md"])
	})

	it("preserves edits and releases the claim when a recovery response fails", async () => {
		mockTurnState = { phase: "error", anchorTs: 2, seq: 4 }
		const failedConversation: ClineMessage[] = [
			{ ts: 1, type: "say", say: "task", text: "task" },
			{ ts: 2, type: "ask", ask: "api_req_failed", text: "provider unavailable" },
		]
		let rejectAskResponse: (error: Error) => void = () => {}
		askResponse.mockImplementationOnce(
			() =>
				new Promise<void>((_resolve, reject) => {
					rejectAskResponse = reject
				}),
		)
		const { result } = renderHook(() => {
			const chatState = useChatState(failedConversation)
			return { chatState, handlers: useMessageHandlers(failedConversation, chatState) }
		})
		act(() => result.current.chatState.setInputValue("submitted draft"))

		let sendPromise: Promise<void> = Promise.resolve()
		await act(async () => {
			sendPromise = result.current.handlers.handleSendMessage("submitted draft", [], [])
			await Promise.resolve()
		})
		act(() => result.current.chatState.setInputValue("newer draft"))

		await act(async () => {
			rejectAskResponse(new Error("transport down"))
			await expect(sendPromise).rejects.toThrow("transport down")
		})
		expect(result.current.chatState.inputValue).toBe("newer draft")
		expect(result.current.handlers.recoveryActionInFlight).toBe(false)
	})

	it("does not show a pending chat bubble when answering an active follow-up question with freeform text", async () => {
		mockTurnState = { phase: "awaiting_followup", anchorTs: 2, seq: 3 }
		const questionConversation: ClineMessage[] = [
			{ ts: 1, type: "say", say: "task", text: "task" },
			{
				ts: 2,
				type: "ask",
				ask: "followup",
				text: JSON.stringify({ question: "Which approach?", options: ["A", "B"] }),
			},
		]
		const setPendingUserMessage = vi.fn()
		const { result } = renderHook(() =>
			useMessageHandlers(questionConversation, makeChatState(questionConversation, { setPendingUserMessage })),
		)

		await act(async () => {
			await result.current.handleSendMessage("something else", [], [])
		})

		expect(askResponse).toHaveBeenCalledTimes(1)
		expect(askResponse).toHaveBeenCalledWith(
			expect.objectContaining({ responseType: "messageResponse", text: "something else" }),
		)
		expect(setPendingUserMessage).not.toHaveBeenCalled()
	})

	it("an empty transcript still starts a NEW task (unchanged behavior)", async () => {
		mockTurnState = { phase: "idle", seq: 1 }
		const setPendingUserMessage = vi.fn()
		const setPendingResponse = vi.fn()
		const { result } = renderHook(() =>
			useMessageHandlers([], makeChatState([], { setPendingUserMessage, setPendingResponse })),
		)

		await act(async () => {
			await result.current.handleSendMessage("brand new task", [], [])
		})

		expect(newTask).toHaveBeenCalledTimes(1)
		expect(askResponse).not.toHaveBeenCalled()
		expect(setPendingResponse).toHaveBeenCalledWith({ id: 1, turnStateSeq: 1, messageCount: 0 })
		expect(setPendingUserMessage).toHaveBeenCalledWith({
			afterTs: 0,
			message: expect.objectContaining({
				type: "say",
				say: "task",
				text: "brand new task",
				partial: false,
			}),
		})
		expect(trackIntent).toHaveBeenCalledWith(
			expect.objectContaining({
				action: "prompt_submitted",
				source: "chat_submit",
				hasText: true,
				hasImages: false,
				hasFiles: false,
				hasActiveTask: false,
				textLength: "brand new task".length,
			}),
		)
	})

	it("restores pending new-task UI state when the RPC fails", async () => {
		mockTurnState = { phase: "idle", seq: 1 }
		const error = new Error("transport down")
		const setInputValue = vi.fn()
		const setQuotes = vi.fn()
		const setSendingDisabled = vi.fn()
		const setSelectedImages = vi.fn()
		const setSelectedFiles = vi.fn()
		const setEnableButtons = vi.fn()
		const setPendingUserMessage = vi.fn()
		const setPendingResponse = vi.fn()
		const chatState = makeChatState([], {
			quotes: [{ text: "selected context", note: "" }],
			sendingDisabled: false,
			enableButtons: true,
			setInputValue,
			setQuotes,
			setSendingDisabled,
			setSelectedImages,
			setSelectedFiles,
			setEnableButtons,
			setPendingUserMessage,
			setPendingResponse,
		})
		const { result } = renderHook(() => useMessageHandlers([], chatState))
		newTask.mockRejectedValueOnce(error)

		let caught: unknown
		await act(async () => {
			try {
				await result.current.handleSendMessage("brand new task", ["image.png"], ["a.ts"])
			} catch (err) {
				caught = err
			}
		})

		expect(caught).toBe(error)
		expect(newTask).toHaveBeenCalledWith(
			expect.objectContaining({
				text: expect.stringContaining("selected context"),
				images: ["image.png"],
				files: ["a.ts"],
			}),
		)
		expect(setInputValue).toHaveBeenNthCalledWith(1, "")
		expect(setInputValue).toHaveBeenLastCalledWith("brand new task")
		expect(setQuotes).toHaveBeenNthCalledWith(1, [])
		expect(setQuotes).toHaveBeenLastCalledWith([{ text: "selected context", note: "" }])
		expect(setSendingDisabled).toHaveBeenNthCalledWith(1, true)
		expect(setSendingDisabled).toHaveBeenLastCalledWith(false)
		expect(setSelectedImages).toHaveBeenNthCalledWith(1, [])
		expect(setSelectedImages).toHaveBeenLastCalledWith(["image.png"])
		expect(setSelectedFiles).toHaveBeenNthCalledWith(1, [])
		expect(setSelectedFiles).toHaveBeenLastCalledWith(["a.ts"])
		expect(setEnableButtons).toHaveBeenNthCalledWith(1, false)
		expect(setEnableButtons).toHaveBeenLastCalledWith(true)
		const optimisticMessage = setPendingUserMessage.mock.calls[0][0]
		const rollbackMessage = setPendingUserMessage.mock.calls.at(-1)?.[0]
		expect(rollbackMessage(optimisticMessage)).toBeUndefined()
		const pendingResponse = setPendingResponse.mock.calls[0][0]
		const rollbackResponse = setPendingResponse.mock.calls.at(-1)?.[0]
		expect(rollbackResponse(pendingResponse)).toBeUndefined()
	})

	it("startNewTask drops any unconfirmed optimistic message so it cannot be re-injected after clearTask", async () => {
		mockTurnState = { phase: "streaming", seq: 2 }
		const streamingConversation: ClineMessage[] = [
			{ ts: 1, type: "say", say: "task", text: "task with attachment" },
			{ ts: 2, type: "say", say: "text", text: "working", partial: true },
		]
		const setPendingUserMessage = vi.fn()
		const setPendingResponse = vi.fn()
		const setQuotes = vi.fn()
		const { result } = renderHook(() =>
			useMessageHandlers(
				streamingConversation,
				makeChatState(streamingConversation, { setQuotes, setPendingUserMessage, setPendingResponse }),
			),
		)

		await act(async () => {
			await result.current.startNewTask()
		})

		expect(clearTask).toHaveBeenCalledTimes(1)
		expect(setPendingUserMessage).toHaveBeenCalledWith(undefined)
		expect(setPendingResponse).toHaveBeenCalledWith(undefined)
		expect(setQuotes).toHaveBeenCalledWith([])
	})

	it("does not clear a quote selected while New Task is pending", async () => {
		mockTurnState = { phase: "awaiting_followup", anchorTs: 2, seq: 3 }
		const newTaskConversation: ClineMessage[] = [
			{ ts: 1, type: "say", say: "task", text: "task" },
			{ ts: 2, type: "ask", ask: "new_task", text: "new task context" },
		]
		let resolveNewTask: (() => void) | undefined
		newTask.mockImplementationOnce(() => new Promise<void>((resolve) => (resolveNewTask = resolve)))
		const { result } = renderHook(() => {
			const chatState = useChatState(newTaskConversation)
			return { chatState, handlers: useMessageHandlers(newTaskConversation, chatState) }
		})
		act(() => result.current.chatState.setQuotes([{ text: "old task quote", note: "" }]))

		let action: Promise<void> | undefined
		act(() => {
			action = result.current.handlers.executeButtonAction({ type: "new_task" })
		})
		act(() => result.current.chatState.setQuotes([{ text: "new draft quote", note: "" }]))
		await act(async () => {
			resolveNewTask?.()
			await action
		})

		expect(result.current.chatState.quotes).toEqual([{ text: "new draft quote", note: "" }])
	})

	it("retries a failed request without changing the unsent draft", async () => {
		mockTurnState = { phase: "error", anchorTs: 2, seq: 3 }
		const failedConversation: ClineMessage[] = [
			{ ts: 1, type: "say", say: "task", text: "task" },
			{ ts: 2, type: "ask", ask: "api_req_failed", text: "server error" },
		]
		const setInputValue = vi.fn()
		const setQuotes = vi.fn()
		const setSelectedImages = vi.fn()
		const setSelectedFiles = vi.fn()
		const draft = {
			revision: 7,
			text: "First paragraph.\n\nSecond paragraph.",
			quotes: [],
			images: ["image.png"],
			files: ["notes.md"],
		}
		const { result } = renderHook(() =>
			useMessageHandlers(
				failedConversation,
				makeChatState(failedConversation, {
					inputValue: draft.text,
					selectedImages: draft.images,
					selectedFiles: draft.files,
					setInputValue,
					setQuotes,
					setSelectedImages,
					setSelectedFiles,
				}),
			),
		)

		await act(async () => {
			await result.current.executeButtonAction({ type: "retry" })
		})

		expect(askResponse).toHaveBeenCalledWith({ responseType: "yesButtonClicked" })
		expect(setInputValue).not.toHaveBeenCalled()
		expect(setQuotes).not.toHaveBeenCalled()
		expect(setSelectedImages).not.toHaveBeenCalled()
		expect(setSelectedFiles).not.toHaveBeenCalled()
	})

	it("clears only the draft snapshot submitted with an approval", async () => {
		mockTurnState = { phase: "awaiting_approval", anchorTs: 2, seq: 3 }
		const approvalConversation: ClineMessage[] = [
			{ ts: 1, type: "say", say: "task", text: "task" },
			{ ts: 2, type: "ask", ask: "tool", text: JSON.stringify({ tool: "newFileCreated", path: "notes.md" }) },
		]
		const consumeDraftSnapshot = vi.fn()
		const draft = {
			revision: 11,
			text: "submitted feedback",
			quotes: [{ text: "selected context", note: "" }],
			images: ["old.png"],
			files: ["old.md"],
			authorizedThreadIds: [],
		}
		const { result } = renderHook(() =>
			useMessageHandlers(approvalConversation, makeChatState(approvalConversation, { consumeDraftSnapshot })),
		)

		await act(async () => {
			await result.current.executeButtonAction({ type: "approve", draft })
		})

		expect(askResponse).toHaveBeenCalledWith({
			responseType: "yesButtonClicked",
			text: `> selected context\n\n${draft.text}`,
			provenance: undefined,
			images: draft.images,
			files: draft.files,
		})
		expect(consumeDraftSnapshot).toHaveBeenCalledWith(draft)
	})

	it("submits quotes as feedback even without typed text", async () => {
		mockTurnState = { phase: "awaiting_approval", anchorTs: 2, seq: 3 }
		const approvalConversation: ClineMessage[] = [
			{ ts: 1, type: "say", say: "task", text: "task" },
			{ ts: 2, type: "ask", ask: "tool", text: JSON.stringify({ tool: "newFileCreated", path: "notes.md" }) },
		]
		const consumeDraftSnapshot = vi.fn()
		const draft = {
			revision: 12,
			text: "  ",
			quotes: [{ text: "selected context", note: "" }],
			images: [],
			files: [],
			authorizedThreadIds: [],
		}
		const { result } = renderHook(() =>
			useMessageHandlers(approvalConversation, makeChatState(approvalConversation, { consumeDraftSnapshot })),
		)

		await act(async () => {
			await result.current.executeButtonAction({ type: "approve", draft })
		})

		expect(askResponse).toHaveBeenCalledWith({
			responseType: "yesButtonClicked",
			text: "> selected context",
			provenance: undefined,
			images: [],
			files: [],
		})
		expect(consumeDraftSnapshot).toHaveBeenCalledWith(draft)
	})

	// The webview does not gate sends on provider usability: submission always
	// reaches the extension, which surfaces auth/config problems as chat errors
	// (emitClineAuthError for the Cline provider, say:"error" otherwise).
	it("always forwards a new task to the extension (no webview-side provider gate)", async () => {
		mockTurnState = { phase: "idle", seq: 1 }
		const { result } = renderHook(() => useMessageHandlers([], makeChatState([])))

		await act(async () => {
			await result.current.handleSendMessage("should be sent", [], [])
		})

		expect(newTask).toHaveBeenCalledTimes(1)
		expect(newTask).toHaveBeenCalledWith(expect.objectContaining({ text: "should be sent", images: [], files: [] }))
		expect(askResponse).not.toHaveBeenCalled()
	})
})

it("submits the displayed approval id even when another ask appears later in the transcript", async () => {
	askResponse.mockClear()
	mockTurnState = { phase: "awaiting_approval", seq: 20, anchorTs: 10 }
	const messages: ClineMessage[] = [
		{ ts: 10, decisionId: "approval-a", type: "ask", ask: "tool", text: "{}" },
		{ ts: 11, decisionId: "question-b", type: "ask", ask: "followup", text: "{}" },
	]
	const { result } = renderHook(() => useMessageHandlers(messages, makeChatState(messages)))
	await act(async () => {
		await result.current.executeButtonAction({
			type: "approve",
			draft: { revision: 0, text: "", quotes: [], images: [], files: [] },
		})
	})
	expect(askResponse).toHaveBeenCalledWith(
		expect.objectContaining({ decisionId: "approval-a", responseType: "yesButtonClicked" }),
	)
	mockTurnState = undefined
})

describe("useMessageHandlers — task pill", () => {
	beforeEach(() => {
		newTask.mockReset()
		newTask.mockResolvedValue(undefined)
		mockTurnState = { phase: "idle", seq: 1 }
		setComposerTaskGroup(undefined)
		setComposerPageTaskGroup(undefined)
	})

	it("on a task page, every background send is filed into the page's task", async () => {
		setComposerPageTaskGroup("group-page")
		const { result } = renderHook(() => useMessageHandlers([], makeChatState([])))

		await act(async () => {
			await result.current.handleSendInBackground("first", [], [])
		})
		await act(async () => {
			await result.current.handleSendInBackground("second", [], [])
		})

		expect(newTask).toHaveBeenCalledTimes(2)
		expect(newTask).toHaveBeenNthCalledWith(1, expect.objectContaining({ text: "first", taskGroupId: "group-page" }))
		expect(newTask).toHaveBeenNthCalledWith(2, expect.objectContaining({ text: "second", taskGroupId: "group-page" }))
	})

	it("on a task page, a foreground send is filed into the page's task", async () => {
		setComposerPageTaskGroup("group-page")
		const { result } = renderHook(() => useMessageHandlers([], makeChatState([])))

		await act(async () => {
			await result.current.handleSendMessage("hello", [], [])
		})

		expect(newTask).toHaveBeenCalledWith(expect.objectContaining({ taskGroupId: "group-page" }))
	})

	it("files a new thread into the task picked with the pill, then clears the pick", async () => {
		setComposerTaskGroup("group-1")
		const { result } = renderHook(() => useMessageHandlers([], makeChatState([])))

		await act(async () => {
			await result.current.handleSendMessage("Look into PROJ-1", [], [])
		})

		expect(newTask).toHaveBeenCalledWith(expect.objectContaining({ text: "Look into PROJ-1", taskGroupId: "group-1" }))
		expect(getComposerTaskGroup()).toBeUndefined()
	})

	it("keeps the pick when starting the thread fails", async () => {
		setComposerTaskGroup("group-1")
		newTask.mockRejectedValueOnce(new Error("boom"))
		const { result } = renderHook(() => useMessageHandlers([], makeChatState([])))

		await act(async () => {
			await result.current.handleSendMessage("hello", [], []).catch(() => {})
		})

		expect(getComposerTaskGroup()).toBe("group-1")
	})

	it("starts unfiled when no task is picked", async () => {
		const { result } = renderHook(() => useMessageHandlers([], makeChatState([])))

		await act(async () => {
			await result.current.handleSendMessage("hello", [], [])
		})

		expect(newTask).toHaveBeenCalledWith(expect.objectContaining({ taskGroupId: undefined }))
	})
})

describe("useMessageHandlers — explicit composer provenance", () => {
	beforeEach(() => {
		newTask.mockReset().mockResolvedValue(undefined)
		askResponse.mockReset().mockResolvedValue(undefined)
		interjectPrompt.mockReset().mockResolvedValue(undefined)
		forkTaskAt.mockReset().mockResolvedValue({ value: "aside-1" })
		showTaskWithId.mockReset().mockResolvedValue(undefined)
		togglePlanActModeProto.mockReset().mockResolvedValue({ value: false })
		mockTurnState = { phase: "completed", seq: 1 } as TurnState
	})

	const PICKED = { authorizedThreadIds: ["1_picked"] }

	// The real chat state, so picks are tracked and pruned the way the composer does it.
	function composer(messages: ClineMessage[]) {
		return renderHook(() => {
			const chatState = useChatState(messages)
			return { chatState, handlers: useMessageHandlers(messages, chatState) }
		})
	}
	function typeAndPick(view: ReturnType<typeof composer>, text: string, ...picked: string[]) {
		act(() => view.result.current.chatState.setInputValue(text))
		for (const id of picked) act(() => view.result.current.chatState.authorizeThread(id))
	}
	const send = (view: ReturnType<typeof composer>, text = view.result.current.chatState.inputValue) =>
		act(async () => {
			await view.result.current.handlers.handleSendMessage(text, [], [])
		})

	it("sends only the picked thread id with a new task, never ids found in quote chips", async () => {
		const view = composer([])
		typeAndPick(view, "compare with thread:1_picked and thread:2_typed", "1_picked")
		act(() => view.result.current.chatState.setQuotes([{ text: "see thread:9_secret", note: "" }]))
		await send(view)

		const request = newTask.mock.calls[0][0]
		expect(request.text).toContain("thread:9_secret")
		expect(request.provenance).toEqual({ ...PICKED, scriptInvocation: undefined })
	})

	it("sends no provenance for thread text that was typed or inserted without picking it", async () => {
		const view = composer([])
		// Add to Cline / a restored draft writes text straight into the draft.
		typeAndPick(view, "from the editor: thread:9_secret")
		await send(view)
		expect(newTask.mock.calls[0][0].provenance).toBeUndefined()
	})

	it("drops a pick when its token is deleted from the text", async () => {
		const view = composer([])
		typeAndPick(view, "compare with thread:1_picked", "1_picked")
		act(() => view.result.current.chatState.setInputValue("compare with nothing"))
		act(() => view.result.current.chatState.setInputValue("compare with thread:1_picked"))
		await send(view)
		expect(newTask.mock.calls[0][0].provenance).toBeUndefined()
	})

	it("drops a pick when its token is edited into a different id", async () => {
		const view = composer([])
		typeAndPick(view, "compare with thread:1_picked", "1_picked")
		act(() => view.result.current.chatState.setInputValue("compare with thread:1_pickedX"))
		await send(view)
		expect(newTask.mock.calls[0][0].provenance).toBeUndefined()
	})

	it("ignores a pick whose token is not in the text", async () => {
		const view = composer([])
		typeAndPick(view, "nothing mentioned", "1_picked")
		await send(view)
		expect(newTask.mock.calls[0][0].provenance).toBeUndefined()
	})

	it("forwards the pick on a normal follow-up in a conversation", async () => {
		const view = composer(completedConversation)
		typeAndPick(view, "what about thread:1_picked?", "1_picked")
		await send(view)
		expect(askResponse.mock.calls[0][0]).toMatchObject({ responseType: "messageResponse", provenance: PICKED })
	})

	it("forwards the pick when answering an ask", async () => {
		mockTurnState = { phase: "awaiting_followup", seq: 1 } as TurnState
		const asking: ClineMessage[] = [
			{ ts: 1, type: "say", say: "text", text: "task" },
			{ ts: 2, type: "ask", ask: "followup", text: "which one?" },
		]
		const view = composer(asking)
		typeAndPick(view, "use thread:1_picked", "1_picked")
		await send(view)
		expect(askResponse.mock.calls[0][0]).toMatchObject({ responseType: "messageResponse", provenance: PICKED })
	})

	it("forwards the pick when rejecting with feedback", async () => {
		mockTurnState = { phase: "awaiting_approval", seq: 1 } as TurnState
		const approval: ClineMessage[] = [
			{ ts: 1, type: "say", say: "text", text: "task" },
			{ ts: 2, type: "ask", ask: "tool", text: JSON.stringify({ tool: "newFileCreated", path: "a.md" }) },
		]
		const view = composer(approval)
		typeAndPick(view, "no, see thread:1_picked", "1_picked")
		const draft = view.result.current.chatState.getDraftSnapshot()
		await act(async () => {
			await view.result.current.handlers.executeButtonAction({ type: "reject", draft })
		})
		expect(askResponse.mock.calls[0][0]).toMatchObject({ responseType: "noButtonClicked", provenance: PICKED })
	})

	it("forwards the pick when interjecting", async () => {
		const view = composer(completedConversation)
		typeAndPick(view, "stop, see thread:1_picked", "1_picked")
		await act(async () => {
			await view.result.current.handlers.handleInterject(view.result.current.chatState.inputValue, [], [])
		})
		expect(interjectPrompt.mock.calls[0][0]).toMatchObject({ provenance: PICKED })
	})

	it("forwards the pick when sending in the background", async () => {
		const view = composer([])
		typeAndPick(view, "go look at thread:1_picked", "1_picked")
		await act(async () => {
			await view.result.current.handlers.handleSendInBackground(view.result.current.chatState.inputValue, [], [])
		})
		expect(newTask.mock.calls[0][0]).toMatchObject({ runInBackground: true, provenance: PICKED })
	})

	it("forwards the pick when starting an aside", async () => {
		const view = composer(completedConversation)
		typeAndPick(view, "side question about thread:1_picked", "1_picked")
		await act(async () => {
			await view.result.current.handlers.handleAside(view.result.current.chatState.inputValue, [], [], 2)
		})
		expect(askResponse.mock.calls[0][0]).toMatchObject({ provenance: PICKED })
	})

	it("forwards the pick through a /ask or /act mode switch", async () => {
		mockMode = "act"
		const view = composer(completedConversation)
		typeAndPick(view, "/ask look at thread:1_picked", "1_picked")
		await send(view)
		expect(togglePlanActModeProto.mock.calls[0][0].chatContent.provenance).toEqual(PICKED)
		mockMode = "act"
	})

	it("sends a chat row's text without the composer's picks", async () => {
		const view = composer(completedConversation)
		typeAndPick(view, "draft with thread:1_picked", "1_picked")
		await send(view, "an option button's text")
		expect(askResponse.mock.calls[0][0].provenance).toBeUndefined()
	})

	it("keeps the pick when a failed send restores the draft", async () => {
		const view = composer(completedConversation)
		typeAndPick(view, "what about thread:1_picked?", "1_picked")
		askResponse.mockRejectedValueOnce(new Error("boom"))
		await act(async () => {
			await view.result.current.handlers.handleSendMessage(view.result.current.chatState.inputValue, [], []).catch(() => {})
		})
		expect(view.result.current.chatState.inputValue).toBe("what about thread:1_picked?")
		await send(view)
		expect(askResponse.mock.calls[1][0].provenance).toEqual(PICKED)
	})

	it("sends the script marker only when the composer recorded a script run for the draft", async () => {
		const view = composer([])
		act(() => view.result.current.chatState.setInputValue("/deploy env:prod"))
		act(() => view.result.current.chatState.setScriptRun({ name: "deploy", values: { env: "prod", dry: true } }))
		await send(view)
		expect(newTask.mock.calls[0][0].provenance).toEqual({
			authorizedThreadIds: [],
			scriptInvocation: { name: "deploy", values: { env: "prod" }, flags: { dry: true } },
		})
	})

	it("sends no script marker for script text that arrived without the composer recording a run", async () => {
		const view = composer([])
		act(() => view.result.current.chatState.setInputValue("/deploy env:prod"))
		await send(view)
		expect(newTask.mock.calls[0][0].provenance).toBeUndefined()
	})

	it("drops the script marker once the draft no longer starts with the script", async () => {
		const view = composer([])
		act(() => view.result.current.chatState.setInputValue("/deploy env:prod"))
		act(() => view.result.current.chatState.setScriptRun({ name: "deploy", values: { env: "prod" } }))
		act(() => view.result.current.chatState.setInputValue("please /deploy env:prod"))
		await send(view)
		expect(newTask.mock.calls[0][0].provenance).toBeUndefined()
	})

	describe("message tags", () => {
		const TAG = {
			threadId: "7_src",
			messageIndex: 3,
			toolCallId: "call_done",
			text: "All fixed.",
			source: "Cline · Dev plan",
		}
		const LINK = { threadId: "7_src", messageIndex: 3, toolCallId: "call_done", block: undefined }

		it("sends the tag's link (not its text or a quote) and authorizes no thread", async () => {
			const view = composer([])
			act(() => view.result.current.chatState.setInputValue("use this"))
			act(() => view.result.current.chatState.setMessageTags([TAG]))
			await send(view)

			const request = newTask.mock.calls[0][0]
			expect(request.text).toBe("use this")
			expect(request.provenance.messageLinks).toEqual([LINK])
			expect(request.provenance.authorizedThreadIds).toEqual([])
		})

		it("forwards the tag on a follow-up, an interject and a background start", async () => {
			const follow = composer(completedConversation)
			act(() => follow.result.current.chatState.setInputValue("again"))
			act(() => follow.result.current.chatState.setMessageTags([TAG]))
			await send(follow)
			expect(askResponse.mock.calls[0][0].provenance.messageLinks).toEqual([LINK])

			const interject = composer(completedConversation)
			act(() => interject.result.current.chatState.setInputValue("now"))
			act(() => interject.result.current.chatState.setMessageTags([TAG]))
			await act(async () => {
				await interject.result.current.handlers.handleInterject("now", [], [])
			})
			expect(interjectPrompt.mock.calls[0][0].provenance.messageLinks).toEqual([LINK])

			const background = composer([])
			act(() => background.result.current.chatState.setInputValue("go"))
			act(() => background.result.current.chatState.setMessageTags([TAG]))
			await act(async () => {
				await background.result.current.handlers.handleSendInBackground("go", [], [])
			})
			expect(newTask.mock.calls.at(-1)?.[0]).toMatchObject({ runInBackground: true })
			expect(newTask.mock.calls.at(-1)?.[0].provenance.messageLinks).toEqual([LINK])
		})

		it("clears the tags once the message is sent", async () => {
			const view = composer([])
			act(() => view.result.current.chatState.setInputValue("use this"))
			act(() => view.result.current.chatState.setMessageTags([TAG]))
			await send(view)
			expect(view.result.current.chatState.messageTags).toEqual([])
		})

		it("puts the tags back when the send fails", async () => {
			newTask.mockRejectedValueOnce(new Error("offline"))
			const view = composer([])
			act(() => view.result.current.chatState.setInputValue("use this"))
			act(() => view.result.current.chatState.setMessageTags([TAG]))
			await act(async () => {
				await view.result.current.handlers.handleSendMessage("use this", [], []).catch(() => {})
			})
			expect(view.result.current.chatState.messageTags).toEqual([TAG])
		})

		it("sends no message links for a send of text other than the draft", async () => {
			const view = composer(completedConversation)
			act(() => view.result.current.chatState.setInputValue("draft"))
			act(() => view.result.current.chatState.setMessageTags([TAG]))
			await send(view, "an option button's text")
			expect(askResponse.mock.calls[0][0].provenance).toBeUndefined()
		})
	})
})
