import type { ExtensionState, TurnState } from "@shared/ExtensionMessage"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import React from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { FULL_COMPOSER_ROW } from "@/components/chat/composer/composerRowLayout"
import { resetPromptStashForTests } from "../../hooks/usePromptStash"
import type { ChatState, MessageHandlers, ScrollBehavior } from "../../types/chatTypes"
import { InputSection } from "./InputSection"

const mockTurnState = vi.fn<() => TurnState | undefined>(() => undefined)
const mockSessionStatuses = vi.fn<() => ExtensionState["sessionStatuses"]>(() => ({}))
vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({
		turnState: mockTurnState(),
		currentTaskItem: { id: "task-1" },
		sessionStatuses: mockSessionStatuses(),
		mode: "act",
	}),
}))

vi.mock("@/components/chat/composer/useFocusedChatModel", () => ({
	useFocusedChatModel: () => ({ provider: "anthropic", modelId: "claude", contextWindow: 100_000 }),
}))
vi.mock("@/hooks/useProviderUsageCostDisplay", () => ({ useProviderUsageCostDisplay: () => "show" }))

const resolveMessageLink = vi.fn()
const stashShortcut = vi.hoisted(() => ({
	callbacks: null as { onResponse: () => void } | null,
	unsubscribed: vi.fn(),
}))
vi.mock("@/services/grpc-client", () => ({
	StateServiceClient: { updateSettings: vi.fn(() => Promise.resolve({})) },
	TaskServiceClient: { resolveMessageLink: (request: unknown) => resolveMessageLink(request) },
	UiServiceClient: {
		subscribeToStashShortcut: (_request: unknown, callbacks: { onResponse: () => void }) => {
			stashShortcut.callbacks = callbacks
			return () => stashShortcut.unsubscribed()
		},
	},
}))

vi.mock("@/components/chat/ChatTextArea", () => ({
	default: React.forwardRef<
		HTMLTextAreaElement,
		{
			sendingDisabled: boolean
			onSend: () => void
			onStash?: () => boolean
			onRestoreStash?: (id: string) => void
			stashEntries?: { id: string; text: string }[]
			quoteTags?: React.ReactNode
			onPasteMessageLink?: (link: { threadId: string; messageIndex: number }, rawUrl: string) => void
			usageIndicator?: { render: (layout: typeof FULL_COMPOSER_ROW) => React.ReactNode }
		}
	>(
		(
			{
				sendingDisabled,
				onSend,
				onStash,
				onRestoreStash,
				stashEntries = [],
				quoteTags,
				usageIndicator,
				onPasteMessageLink,
			},
			ref,
		) => (
			<>
				{quoteTags}
				<button
					onClick={() => onPasteMessageLink?.({ threadId: "t9", messageIndex: 4 }, "vscode://x/thread/t9?m=4")}
					type="button">
					Paste link
				</button>
				<button
					onClick={() =>
						onPasteMessageLink?.(
							{ threadId: "t9", messageIndex: 4, toolCallId: "call_1" },
							"vscode://x/thread/t9?m=4&t=call_1",
						)
					}
					type="button">
					Paste anchored link
				</button>
				{usageIndicator?.render(FULL_COMPOSER_ROW)}
				<button onClick={() => onStash?.()} type="button">
					Stash
				</button>
				{stashEntries.map((entry) => (
					<button key={entry.id} onClick={() => onRestoreStash?.(entry.id)} type="button">
						{`Restore ${entry.text}`}
					</button>
				))}
				<textarea
					aria-label="composer"
					disabled={sendingDisabled}
					onKeyDown={(event) => {
						if (event.key === "Enter" && !sendingDisabled) {
							onSend()
						}
					}}
					ref={ref}
				/>
				<button disabled={sendingDisabled} onClick={onSend} type="button">
					Send
				</button>
			</>
		),
	),
}))

function makeChatState(overrides: Partial<ChatState> = {}): ChatState {
	return {
		quotes: [],
		setQuotes: vi.fn(),
		messageTags: [],
		setMessageTags: vi.fn(),
		addQuote: vi.fn(),
		isTextAreaFocused: false,
		inputValue: "queue this",
		setInputValue: vi.fn(),
		sendingDisabled: true,
		selectedImages: [],
		setSelectedImages: vi.fn(),
		selectedFiles: [],
		setSelectedFiles: vi.fn(),
		textAreaRef: { current: null },
		handleFocusChange: vi.fn(),
		...overrides,
	} as unknown as ChatState
}

function makeScrollBehavior(): ScrollBehavior {
	return {
		isAtBottom: true,
		scrollToBottomAuto: vi.fn(),
	} as unknown as ScrollBehavior
}

describe("InputSection", () => {
	it("allows submit while the turn is streaming so the message can be queued", () => {
		mockTurnState.mockReturnValue({ phase: "streaming", seq: 1 })
		const handleSendMessage = vi.fn().mockResolvedValue(undefined)

		render(
			<InputSection
				chatState={makeChatState({ sendingDisabled: true })}
				messageHandlers={{ handleSendMessage } as unknown as MessageHandlers}
				placeholderText="Type a message"
				scrollBehavior={makeScrollBehavior()}
				selectFilesAndImages={vi.fn()}
				shouldDisableFilesAndImages={false}
			/>,
		)

		const composer = screen.getByLabelText("composer")
		expect(composer).not.toBeDisabled()
		const sendButton = screen.getByRole("button", { name: "Send" })
		expect(sendButton).not.toBeDisabled()

		fireEvent.click(sendButton)
		expect(handleSendMessage).toHaveBeenCalledWith("queue this", [], [])
		handleSendMessage.mockClear()
		fireEvent.keyDown(composer, { key: "Enter" })
		expect(handleSendMessage).toHaveBeenCalledWith("queue this", [], [])
	})

	it("allows submit while approval is pending so typed feedback can reject the approval", () => {
		mockTurnState.mockReturnValue({ phase: "awaiting_approval", seq: 1 })
		const handleSendMessage = vi.fn().mockResolvedValue(undefined)

		render(
			<InputSection
				chatState={makeChatState({ sendingDisabled: true })}
				messageHandlers={{ handleSendMessage } as unknown as MessageHandlers}
				placeholderText="Type a message"
				scrollBehavior={makeScrollBehavior()}
				selectFilesAndImages={vi.fn()}
				shouldDisableFilesAndImages={false}
			/>,
		)

		const composer = screen.getByLabelText("composer")
		expect(composer).not.toBeDisabled()

		fireEvent.keyDown(composer, { key: "Enter" })
		expect(handleSendMessage).toHaveBeenCalledWith("queue this", [], [])
	})

	it("allows submit for legacy active-task state when turnState is unavailable", () => {
		mockTurnState.mockReturnValue(undefined)
		const handleSendMessage = vi.fn().mockResolvedValue(undefined)

		render(
			<InputSection
				chatState={makeChatState({
					lastMessage: { ts: 1, type: "say", say: "api_req_started", partial: false },
					sendingDisabled: true,
				})}
				messageHandlers={{ handleSendMessage } as unknown as MessageHandlers}
				placeholderText="Type a message"
				scrollBehavior={makeScrollBehavior()}
				selectFilesAndImages={vi.fn()}
				shouldDisableFilesAndImages={false}
			/>,
		)

		const composer = screen.getByLabelText("composer")
		expect(composer).not.toBeDisabled()

		fireEvent.keyDown(composer, { key: "Enter" })
		expect(handleSendMessage).toHaveBeenCalledWith("queue this", [], [])
	})

	it("allows submit after a failed request so the draft can start the next turn", () => {
		mockTurnState.mockReturnValue({ phase: "error", seq: 1 })
		const handleSendMessage = vi.fn().mockResolvedValue(undefined)

		render(
			<InputSection
				chatState={makeChatState({ clineAsk: "api_req_failed", sendingDisabled: true })}
				messageHandlers={
					{
						errorRecoveryAvailable: true,
						handleSendMessage,
						recoveryActionInFlight: false,
					} as unknown as MessageHandlers
				}
				placeholderText="Type a message"
				scrollBehavior={makeScrollBehavior()}
				selectFilesAndImages={vi.fn()}
				shouldDisableFilesAndImages={false}
			/>,
		)

		const composer = screen.getByLabelText("composer")
		expect(composer).not.toBeDisabled()

		fireEvent.keyDown(composer, { key: "Enter" })
		expect(handleSendMessage).toHaveBeenCalledWith("queue this", [], [])
	})

	it("keeps submit disabled in the error phase when no recovery is offered", () => {
		mockTurnState.mockReturnValue({ phase: "error", seq: 1 })
		const handleSendMessage = vi.fn().mockResolvedValue(undefined)

		render(
			<InputSection
				chatState={makeChatState({ clineAsk: undefined, sendingDisabled: true })}
				messageHandlers={
					{
						errorRecoveryAvailable: false,
						handleSendMessage,
						recoveryActionInFlight: false,
					} as unknown as MessageHandlers
				}
				placeholderText="Type a message"
				scrollBehavior={makeScrollBehavior()}
				selectFilesAndImages={vi.fn()}
				shouldDisableFilesAndImages={false}
			/>,
		)

		expect(screen.getByLabelText("composer")).toBeDisabled()
		expect(screen.getByRole("button", { name: "Send" })).toBeDisabled()
	})

	it("disables a second error-state submit while the first response is pending", () => {
		mockTurnState.mockReturnValue({ phase: "error", seq: 1 })
		const handleSendMessage = vi.fn().mockResolvedValue(undefined)

		render(
			<InputSection
				chatState={makeChatState({
					clineAsk: "api_req_failed",
					pendingResponse: { id: 1, turnStateSeq: 1, messageCount: 2 },
					sendingDisabled: true,
				})}
				messageHandlers={
					{
						errorRecoveryAvailable: true,
						handleSendMessage,
						recoveryActionInFlight: false,
					} as unknown as MessageHandlers
				}
				placeholderText="Type a message"
				scrollBehavior={makeScrollBehavior()}
				selectFilesAndImages={vi.fn()}
				shouldDisableFilesAndImages={false}
			/>,
		)

		const composer = screen.getByLabelText("composer")
		expect(composer).toBeDisabled()
		const sendButton = screen.getByRole("button", { name: "Send" })
		expect(sendButton).toBeDisabled()

		fireEvent.click(sendButton)
		fireEvent.keyDown(composer, { key: "Enter" })
		expect(handleSendMessage).not.toHaveBeenCalled()
	})

	it("disables recovery submit while a footer action is in flight", () => {
		mockTurnState.mockReturnValue({ phase: "error", seq: 1 })

		render(
			<InputSection
				chatState={makeChatState({ clineAsk: "api_req_failed", sendingDisabled: true })}
				messageHandlers={
					{
						errorRecoveryAvailable: true,
						handleSendMessage: vi.fn(),
						recoveryActionInFlight: true,
					} as unknown as MessageHandlers
				}
				placeholderText="Type a message"
				scrollBehavior={makeScrollBehavior()}
				selectFilesAndImages={vi.fn()}
				shouldDisableFilesAndImages={false}
			/>,
		)

		expect(screen.getByLabelText("composer")).toBeDisabled()
		expect(screen.getByRole("button", { name: "Send" })).toBeDisabled()
	})

	describe("Compact", () => {
		beforeEach(() => {
			mockSessionStatuses.mockReturnValue({})
			vi.stubGlobal(
				"ResizeObserver",
				class ResizeObserver {
					observe() {}
					unobserve() {}
					disconnect() {}
				},
			)
		})

		const renderWithUsage = () =>
			render(
				<InputSection
					apiMetrics={{ totalTokensIn: 80_000, totalTokensOut: 5_000, totalCost: 0 }}
					chatState={makeChatState({ sendingDisabled: false })}
					lastApiReqTotalTokens={90_000}
					messageHandlers={{ handleSendMessage: vi.fn(), compactTask: vi.fn() } as unknown as MessageHandlers}
					placeholderText="Type a message"
					scrollBehavior={makeScrollBehavior()}
					selectFilesAndImages={vi.fn()}
					shouldDisableFilesAndImages={false}
				/>,
			)

		it("is not offered during a live question: the runtime is still running", () => {
			mockTurnState.mockReturnValue({ phase: "awaiting_followup", seq: 1 })
			mockSessionStatuses.mockReturnValue({ "task-1": "waiting" })
			renderWithUsage()

			expect(screen.queryByTestId("compact-nudge")).toBeNull()
			fireEvent.click(screen.getByTestId("context-usage-button"))
			expect(screen.getByTestId("compact-now-button")).toBeDisabled()
		})

		it("is offered for a followup after the turn ended", () => {
			mockTurnState.mockReturnValue({ phase: "awaiting_followup", seq: 1 })
			mockSessionStatuses.mockReturnValue({ "task-1": "done" })
			renderWithUsage()

			expect(screen.getByTestId("compact-nudge")).toBeInTheDocument()
			fireEvent.click(screen.getByTestId("context-usage-button"))
			expect(screen.getByTestId("compact-now-button")).toBeEnabled()
		})
	})

	describe("quotes and stash", () => {
		beforeEach(() => resetPromptStashForTests())

		const renderSection = (chatState: ChatState) =>
			render(
				<InputSection
					chatState={chatState}
					messageHandlers={{ handleSendMessage: vi.fn() } as unknown as MessageHandlers}
					placeholderText="Type a message"
					scrollBehavior={makeScrollBehavior()}
					selectFilesAndImages={vi.fn()}
					shouldDisableFilesAndImages={false}
				/>,
			)

		it("renders quotes as inline tags inside the composer, not a stacked note panel", () => {
			const setQuotes = vi.fn()
			renderSection(
				makeChatState({
					quotes: [
						{ text: "first passage", note: "" },
						{ text: "second passage", note: "why?" },
					],
					setQuotes,
				}),
			)

			expect(screen.getAllByTestId("quote-tag")).toHaveLength(2)
			expect(screen.getByText("first passage")).toBeInTheDocument()
			expect(screen.queryByLabelText("Note on this quote")).toBeNull()

			fireEvent.click(screen.getAllByRole("button", { name: "Remove quote" })[0])
			const removal = setQuotes.mock.calls[0][0] as (q: ChatState["quotes"]) => ChatState["quotes"]
			expect(
				removal([
					{ text: "first passage", note: "" },
					{ text: "second passage", note: "why?" },
				]),
			).toEqual([{ text: "second passage", note: "why?" }])
		})

		it("renders no quote row without quotes", () => {
			renderSection(makeChatState())
			expect(screen.queryByTestId("quote-tag-list")).toBeNull()
		})

		it("stashes text + quotes and clears them, then restores the entry", () => {
			const setInputValue = vi.fn()
			const setQuotes = vi.fn()
			const quotes = [{ text: "q", note: "n" }]
			const { rerender } = renderSection(makeChatState({ inputValue: "draft", quotes, setInputValue, setQuotes }))

			fireEvent.click(screen.getByRole("button", { name: "Stash" }))
			expect(setInputValue).toHaveBeenCalledWith("")
			expect(setQuotes).toHaveBeenCalledWith([])

			rerender(
				<InputSection
					chatState={makeChatState({ inputValue: "", quotes: [], setInputValue, setQuotes })}
					messageHandlers={{ handleSendMessage: vi.fn() } as unknown as MessageHandlers}
					placeholderText="Type a message"
					scrollBehavior={makeScrollBehavior()}
					selectFilesAndImages={vi.fn()}
					shouldDisableFilesAndImages={false}
				/>,
			)
			fireEvent.click(screen.getByRole("button", { name: "Restore draft" }))

			expect(setInputValue).toHaveBeenLastCalledWith("draft")
			expect(setQuotes).toHaveBeenLastCalledWith(quotes)
			expect(screen.queryByRole("button", { name: "Restore draft" })).toBeNull()
		})

		it("round-trips message tags through the stash", () => {
			const setInputValue = vi.fn()
			const setQuotes = vi.fn()
			const setMessageTags = vi.fn()
			const tag = { threadId: "t9", messageIndex: 4, toolCallId: "call_1", text: "Cap exports", source: "You · Dev plan" }
			const { rerender } = renderSection(
				makeChatState({ inputValue: "", messageTags: [tag], setInputValue, setQuotes, setMessageTags }),
			)

			// A draft that holds only a message tag is still stashable.
			fireEvent.click(screen.getByRole("button", { name: "Stash" }))
			expect(setMessageTags).toHaveBeenCalledWith([])

			rerender(
				<InputSection
					chatState={makeChatState({ inputValue: "", messageTags: [], setInputValue, setQuotes, setMessageTags })}
					messageHandlers={{ handleSendMessage: vi.fn() } as unknown as MessageHandlers}
					placeholderText="Type a message"
					scrollBehavior={makeScrollBehavior()}
					selectFilesAndImages={vi.fn()}
					shouldDisableFilesAndImages={false}
				/>,
			)
			expect(screen.getByRole("button", { name: /Restore/ })).toBeInTheDocument()
			fireEvent.click(screen.getByRole("button", { name: /Restore/ }))
			expect(setMessageTags).toHaveBeenLastCalledWith([tag])
		})

		it("stashes the draft when the host posts the ⌘S stash shortcut event", () => {
			const setInputValue = vi.fn()
			const setQuotes = vi.fn()
			const quotes = [{ text: "q", note: "n" }]
			renderSection(makeChatState({ inputValue: "keep for later", quotes, setInputValue, setQuotes }))

			act(() => stashShortcut.callbacks?.onResponse())

			expect(setInputValue).toHaveBeenCalledWith("")
			expect(setQuotes).toHaveBeenCalledWith([])
			expect(screen.getByRole("button", { name: "Restore keep for later" })).toBeInTheDocument()
		})

		it("ignores the stash shortcut event when the draft is empty", () => {
			const setInputValue = vi.fn()
			const setQuotes = vi.fn()
			renderSection(makeChatState({ inputValue: "  ", quotes: [], setInputValue, setQuotes }))

			act(() => stashShortcut.callbacks?.onResponse())

			expect(setInputValue).not.toHaveBeenCalled()
			expect(setQuotes).not.toHaveBeenCalled()
		})

		it("unsubscribes from the stash shortcut stream on unmount", () => {
			const { unmount } = renderSection(makeChatState())
			expect(stashShortcut.callbacks).not.toBeNull()
			unmount()
			expect(stashShortcut.unsubscribed).toHaveBeenCalled()
		})
	})

	describe("pasted message links", () => {
		const renderWith = (chatState: ChatState) =>
			render(
				<InputSection
					chatState={chatState}
					messageHandlers={{ handleSendMessage: vi.fn() } as unknown as MessageHandlers}
					placeholderText="Type a message"
					scrollBehavior={makeScrollBehavior()}
					selectFilesAndImages={vi.fn()}
					shouldDisableFilesAndImages={false}
				/>,
			)

		it("becomes a message tag (not a quote) attributed to its author and thread", async () => {
			resolveMessageLink.mockResolvedValue({ author: "user", threadTitle: "Dev plan", text: "Cap exports at 10k rows" })
			const setQuotes = vi.fn()
			const setMessageTags = vi.fn()
			const setInputValue = vi.fn()
			renderWith(makeChatState({ setQuotes, setMessageTags, setInputValue }))

			fireEvent.click(screen.getByRole("button", { name: "Paste link" }))

			await waitFor(() => expect(setMessageTags).toHaveBeenCalled())
			expect(resolveMessageLink).toHaveBeenCalledWith(expect.objectContaining({ threadId: "t9", messageIndex: 4 }))
			const update = setMessageTags.mock.calls[0][0] as (current: unknown[]) => unknown[]
			expect(update([])).toEqual([
				{ threadId: "t9", messageIndex: 4, text: "Cap exports at 10k rows", source: "You · Dev plan" },
			])
			expect(setQuotes).not.toHaveBeenCalled()
			expect(setInputValue).not.toHaveBeenCalled()
		})

		it("labels an assistant message with Cline and keeps the row anchor", async () => {
			resolveMessageLink.mockResolvedValue({ author: "assistant", threadTitle: "Dev plan", text: "Done." })
			const setMessageTags = vi.fn()
			renderWith(makeChatState({ setMessageTags }))
			fireEvent.click(screen.getByRole("button", { name: "Paste anchored link" }))
			await waitFor(() => expect(setMessageTags).toHaveBeenCalled())
			const update = setMessageTags.mock.calls[0][0] as (current: unknown[]) => unknown[]
			expect(update([])).toEqual([
				{ threadId: "t9", messageIndex: 4, toolCallId: "call_1", text: "Done.", source: "Cline · Dev plan" },
			])
		})

		it("does not add the same message twice", async () => {
			resolveMessageLink.mockResolvedValue({ author: "user", threadTitle: "Dev plan", text: "Cap exports" })
			const setMessageTags = vi.fn()
			renderWith(makeChatState({ setMessageTags }))
			fireEvent.click(screen.getByRole("button", { name: "Paste link" }))
			await waitFor(() => expect(setMessageTags).toHaveBeenCalled())
			const update = setMessageTags.mock.calls[0][0] as (current: unknown[]) => unknown[]
			const once = update([])
			expect(update(once)).toBe(once)
		})

		it("renders the tag chip in the composer next to the quotes, with a remove button", () => {
			const setMessageTags = vi.fn()
			const tag = { threadId: "t9", messageIndex: 4, text: "Cap exports", source: "You · Dev plan" }
			renderWith(makeChatState({ messageTags: [tag], quotes: [{ text: "q", note: "" }], setMessageTags }))
			expect(screen.getByTestId("message-tag-source")).toHaveTextContent("You · Dev plan")
			expect(screen.getAllByTestId("quote-tag")).toHaveLength(1)
			fireEvent.click(screen.getByRole("button", { name: "Remove message" }))
			const update = setMessageTags.mock.calls[0][0] as (current: unknown[]) => unknown[]
			expect(update([tag])).toEqual([])
		})

		it("falls back to the literal URL when the message can't be resolved", async () => {
			resolveMessageLink.mockResolvedValue({ author: "", threadTitle: "", text: "" })
			const setQuotes = vi.fn()
			const setInputValue = vi.fn()
			renderWith(makeChatState({ setQuotes, setInputValue }))

			fireEvent.click(screen.getByRole("button", { name: "Paste link" }))

			await waitFor(() => expect(setInputValue).toHaveBeenCalled())
			expect(setQuotes).not.toHaveBeenCalled()
			const update = setInputValue.mock.calls[0][0] as (current: string) => string
			expect(update("see")).toBe("see vscode://x/thread/t9?m=4 ")
		})

		it("falls back to the literal URL when the host request fails", async () => {
			resolveMessageLink.mockRejectedValue(new Error("gone"))
			const setMessageTags = vi.fn()
			const setInputValue = vi.fn()
			vi.spyOn(console, "error").mockImplementation(() => {})
			renderWith(makeChatState({ setMessageTags, setInputValue }))
			fireEvent.click(screen.getByRole("button", { name: "Paste link" }))
			await waitFor(() => expect(setInputValue).toHaveBeenCalled())
			expect(setMessageTags).not.toHaveBeenCalled()
		})
	})
})
