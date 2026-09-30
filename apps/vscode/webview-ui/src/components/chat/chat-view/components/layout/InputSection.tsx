import React, { useCallback, useEffect, useRef } from "react"
import ChatTextArea from "@/components/chat/ChatTextArea"
import QuotedMessagePreview from "@/components/chat/QuotedMessagePreview"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { usePromptStash } from "../../hooks/usePromptStash"
import { ChatState, MessageHandlers, ScrollBehavior } from "../../types/chatTypes"

interface InputSectionProps {
	chatState: ChatState
	messageHandlers: MessageHandlers
	scrollBehavior: ScrollBehavior
	placeholderText: string
	shouldDisableFilesAndImages: boolean
	selectFilesAndImages: () => Promise<void>
}

/**
 * Input section including quoted message preview and chat text area
 */
export const InputSection: React.FC<InputSectionProps> = ({
	chatState,
	messageHandlers,
	scrollBehavior,
	placeholderText,
	shouldDisableFilesAndImages,
	selectFilesAndImages,
}) => {
	const {
		quotes,
		setQuotes,
		isTextAreaFocused,
		inputValue,
		setInputValue,
		sendingDisabled,
		selectedImages,
		setSelectedImages,
		selectedFiles,
		setSelectedFiles,
		textAreaRef,
		handleFocusChange,
		lastMessage,
		pendingResponse,
	} = chatState

	const { isAtBottom, scrollToBottomAuto } = scrollBehavior
	const { turnState, currentTaskItem, enterSendsAs = "steer" } = useExtensionState()
	const promptStash = usePromptStash(currentTaskItem?.id)
	const legacyTaskRunning =
		turnState === undefined &&
		(lastMessage?.partial === true || (lastMessage?.type === "say" && lastMessage.say === "api_req_started"))
	const allowSubmitWhileDisabled =
		turnState?.phase === "streaming" ||
		turnState?.phase === "awaiting_approval" ||
		(messageHandlers.errorRecoveryAvailable && pendingResponse === undefined && !messageHandlers.recoveryActionInFlight) ||
		legacyTaskRunning
	const submitDisabled = sendingDisabled && !allowSubmitWhileDisabled
	const isRunning = turnState?.phase === "streaming" || legacyTaskRunning
	const runningPlaceholder =
		enterSendsAs === "interject"
			? "Interject with Enter, steer with Ctrl/⌘+Enter"
			: "Steer with Enter, interject with Ctrl/⌘+Enter"

	// Focus the note of a quote only when it was just added, not when quotes are restored in bulk.
	const prevQuoteCountRef = useRef(quotes.length)
	const focusNewQuoteNote = quotes.length === prevQuoteCountRef.current + 1
	useEffect(() => {
		prevQuoteCountRef.current = quotes.length
	}, [quotes.length])

	const focusComposer = useCallback(() => textAreaRef.current?.focus(), [textAreaRef])

	const handleStash = useCallback(() => {
		if (!promptStash.stash({ text: inputValue, quotes })) {
			return false
		}
		setInputValue("")
		setQuotes([])
		return true
	}, [promptStash, inputValue, quotes, setInputValue, setQuotes])

	const handleSendAs = useCallback(
		(kind: "interject" | "aside") => {
			const send = kind === "interject" ? messageHandlers.handleInterject : messageHandlers.handleAside
			void send(inputValue, selectedImages, selectedFiles)
		},
		[messageHandlers, inputValue, selectedImages, selectedFiles],
	)

	const handleRestoreStash = useCallback(
		(id: string) => {
			const restored = promptStash.restore(id, { text: inputValue, quotes })
			if (!restored) {
				return
			}
			prevQuoteCountRef.current = restored.quotes.length
			setInputValue(restored.text)
			setQuotes(restored.quotes)
			focusComposer()
		},
		[promptStash, inputValue, quotes, setInputValue, setQuotes, focusComposer],
	)

	return (
		<>
			{quotes.length > 0 && (
				<div className="flex flex-col gap-0.5" style={{ marginBottom: "-12px", marginTop: "10px" }}>
					{quotes.map((quote, index) => (
						<QuotedMessagePreview
							autoFocusNote={focusNewQuoteNote && index === quotes.length - 1}
							isFocused={isTextAreaFocused}
							// biome-ignore lint/suspicious/noArrayIndexKey: quotes have no id and are only appended or removed
							key={index}
							note={quote.note}
							onDismiss={() => setQuotes((current) => current.filter((_, i) => i !== index))}
							onNoteChange={(note) =>
								setQuotes((current) => current.map((q, i) => (i === index ? { ...q, note } : q)))
							}
							onNoteDone={focusComposer}
							text={quote.text}
						/>
					))}
				</div>
			)}

			<ChatTextArea
				enterSendsAs={enterSendsAs}
				hasQuotes={quotes.length > 0}
				inputValue={inputValue}
				isRunning={isRunning}
				onDeleteStash={promptStash.remove}
				onFocusChange={handleFocusChange}
				onHeightChange={() => {
					if (isAtBottom) {
						scrollToBottomAuto()
					}
				}}
				onRestoreStash={handleRestoreStash}
				onSelectFilesAndImages={selectFilesAndImages}
				onSend={() => messageHandlers.handleSendMessage(inputValue, selectedImages, selectedFiles)}
				onSendAs={handleSendAs}
				onStash={handleStash}
				placeholderText={isRunning ? runningPlaceholder : placeholderText}
				ref={textAreaRef}
				selectedFiles={selectedFiles}
				selectedImages={selectedImages}
				sendingDisabled={submitDisabled}
				setInputValue={setInputValue}
				setSelectedFiles={setSelectedFiles}
				setSelectedImages={setSelectedImages}
				shouldDisableFilesAndImages={shouldDisableFilesAndImages}
				stashEntries={promptStash.entries}
			/>
		</>
	)
}
