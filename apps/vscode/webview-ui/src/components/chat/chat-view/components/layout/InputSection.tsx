import React, { useCallback, useEffect, useRef } from "react"
import ChatTextArea from "@/components/chat/ChatTextArea"
import { ContextUsageIndicator, useComposerContextUsage } from "@/components/chat/composer/ContextUsageIndicator"
import {
	canCompactNow,
	contextUsagePercent,
	formatChatCost,
	isCompactionRunning,
	showsCompactNudge,
} from "@/components/chat/composer/contextUsage"
import { QuoteTagList } from "@/components/chat/QuoteTag"
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
	/** The open chat's usage, for the context meter. Omitted on the home composer. */
	apiMetrics?: {
		totalTokensIn: number
		totalTokensOut: number
		totalCacheWrites?: number
		totalCacheReads?: number
		totalCost: number
	}
	lastApiReqTotalTokens?: number
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
	apiMetrics,
	lastApiReqTotalTokens,
}) => {
	const {
		quotes,
		setQuotes,
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
	const {
		turnState,
		currentTaskItem,
		enterSendsAs = "steer",
		clineMessages = [],
		mode,
		subagentView,
		sessionStatuses,
	} = useExtensionState()
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
	const canCompact = canCompactNow({
		turnPhase: turnState?.phase,
		sessionStatus: currentTaskItem ? sessionStatuses?.[currentTaskItem.id] : undefined,
		legacyRunning: legacyTaskRunning,
		isSubagentView: !!subagentView,
		errorRecoveryAvailable: messageHandlers.errorRecoveryAvailable,
		compactionRunning: isCompactionRunning(clineMessages),
	})
	const usage = useComposerContextUsage(mode, apiMetrics?.totalCost)
	const runningPlaceholder =
		enterSendsAs === "interject"
			? "Interject with Enter, steer with Ctrl/⌘+Enter"
			: "Steer with Enter, interject with Ctrl/⌘+Enter"

	// Open the note editor of a quote only when it was just added, not when quotes are restored in bulk.
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
		(kind: "interject" | "aside" | "background") => {
			const send =
				kind === "interject"
					? messageHandlers.handleInterject
					: kind === "aside"
						? messageHandlers.handleAside
						: messageHandlers.handleSendInBackground
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
		<ChatTextArea
			enterSendsAs={enterSendsAs}
			hasQuotes={quotes.length > 0}
			inputValue={inputValue}
			isHome={!currentTaskItem}
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
			quoteTags={
				quotes.length > 0 ? (
					<QuoteTagList
						autoOpenIndex={focusNewQuoteNote ? quotes.length - 1 : undefined}
						focusComposer={focusComposer}
						quotes={quotes}
						setQuotes={setQuotes}
					/>
				) : undefined
			}
			ref={textAreaRef}
			selectedFiles={selectedFiles}
			selectedImages={selectedImages}
			sendingDisabled={submitDisabled}
			setInputValue={setInputValue}
			setSelectedFiles={setSelectedFiles}
			setSelectedImages={setSelectedImages}
			shouldDisableFilesAndImages={shouldDisableFilesAndImages}
			stashEntries={promptStash.entries}
			usageIndicator={
				currentTaskItem && apiMetrics
					? {
							hasCost: formatChatCost(usage.cost) !== undefined,
							hasCompactNudge: showsCompactNudge(
								canCompact,
								contextUsagePercent(lastApiReqTotalTokens, usage.contextWindow),
							),
							render: ({ showCost, inlineCompactNudge }) => (
								<ContextUsageIndicator
									{...usage}
									cacheReads={apiMetrics.totalCacheReads}
									cacheWrites={apiMetrics.totalCacheWrites}
									canCompact={canCompact}
									inlineCompactNudge={inlineCompactNudge}
									onCompact={() =>
										void messageHandlers
											.compactTask()
											.catch((err) => console.error("Failed to compact task:", err))
									}
									showCost={showCost}
									tokensIn={apiMetrics.totalTokensIn}
									tokensOut={apiMetrics.totalTokensOut}
									usedTokens={lastApiReqTotalTokens}
								/>
							),
						}
					: undefined
			}
		/>
	)
}
