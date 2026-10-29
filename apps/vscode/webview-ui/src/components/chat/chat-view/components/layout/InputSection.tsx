import type { CostBreakdownRow } from "@shared/getApiMetrics"
import type { ParsedMessageLink } from "@shared/message-links"
import { ResolveMessageLinkRequest } from "@shared/proto/cline/task"
import React, { useCallback, useEffect, useLayoutEffect, useRef } from "react"
import ChatTextArea from "@/components/chat/ChatTextArea"
import { ContextUsageIndicator, useComposerContextUsage } from "@/components/chat/composer/ContextUsageIndicator"
import {
	canCompactNow,
	contextUsagePercent,
	isCompactionRunning,
	showsCompactNudge,
} from "@/components/chat/composer/contextUsage"
import { MessageTagList, sameMessageTag } from "@/components/chat/MessageTag"
import { QuoteTagList } from "@/components/chat/QuoteTag"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { TaskServiceClient, UiServiceClient } from "@/services/grpc-client"
import { modKeyLabel } from "@/utils/platformUtils"
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
	/** Usage and cost per model for the context popover. */
	costBreakdown?: CostBreakdownRow[]
	/** Opens a task group's page (the task pill's "Open task"). */
	onOpenTaskGroup?: (taskGroupId: string) => void
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
	costBreakdown,
	onOpenTaskGroup,
}) => {
	const {
		quotes,
		setQuotes,
		messageTags = [],
		setMessageTags,
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
		useAutoCondense,
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
			? `Interject with Enter, steer with ${modKeyLabel()}+Enter`
			: `Steer with Enter, interject with ${modKeyLabel()}+Enter`

	// Open the note editor of a quote only when it was just added, not when quotes are restored in bulk.
	const prevQuoteCountRef = useRef(quotes.length)
	const focusNewQuoteNote = quotes.length === prevQuoteCountRef.current + 1
	useEffect(() => {
		prevQuoteCountRef.current = quotes.length
	}, [quotes.length])

	const focusComposer = useCallback(() => textAreaRef.current?.focus(), [textAreaRef])

	const handleStash = useCallback(() => {
		if (!promptStash.stash({ text: inputValue, quotes, messageTags })) {
			return false
		}
		setInputValue("")
		setQuotes([])
		setMessageTags([])
		return true
	}, [promptStash, inputValue, quotes, messageTags, setInputValue, setQuotes, setMessageTags])

	// ⌘S / Ctrl+S reaches the webview as a host event: the workbench claims the
	// key (cline.stashShortcut) and posts here. Subscribing once via a ref keeps
	// the stream stable while handleStash is rebuilt on each keystroke.
	const handleStashRef = useRef(handleStash)
	useLayoutEffect(() => {
		handleStashRef.current = handleStash
	})
	useEffect(() => {
		const cleanup = UiServiceClient.subscribeToStashShortcut(
			{},
			{
				onResponse: () => {
					handleStashRef.current()
				},
				onError: (error: unknown) => {
					console.error("Error in stashShortcut subscription:", error)
				},
				onComplete: () => {},
			},
		)
		return cleanup
	}, [])

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
			const restored = promptStash.restore(id, { text: inputValue, quotes, messageTags })
			if (!restored) {
				return
			}
			prevQuoteCountRef.current = restored.quotes.length
			setInputValue(restored.text)
			setQuotes(restored.quotes)
			setMessageTags(restored.messageTags ?? [])
			focusComposer()
		},
		[promptStash, inputValue, quotes, messageTags, setInputValue, setQuotes, setMessageTags, focusComposer],
	)

	// A pasted vscode:// message link becomes a message tag: a context connection
	// (not a quote, so no note) that shows the message on hover and hands the
	// host the link to resolve on send. "You · <thread>" attribution comes from
	// the host. Unresolvable links fall back to inserting the URL literally.
	const handlePasteMessageLink = useCallback(
		(link: ParsedMessageLink, rawUrl: string) => {
			const insertRawUrl = () =>
				setInputValue((current) => current + (current && !current.endsWith(" ") ? " " : "") + rawUrl + " ")
			TaskServiceClient.resolveMessageLink(
				ResolveMessageLinkRequest.create({
					threadId: link.threadId,
					messageIndex: link.messageIndex,
					toolCallId: link.toolCallId,
					block: link.block,
				}),
			)
				.then((info) => {
					if (info.text) {
						const who = info.author === "user" ? "You" : "Cline"
						const source = info.threadTitle ? `${who} · ${info.threadTitle}` : who
						const tag = {
							threadId: link.threadId,
							messageIndex: link.messageIndex,
							...(link.toolCallId ? { toolCallId: link.toolCallId } : {}),
							...(link.block !== undefined ? { block: link.block } : {}),
							text: info.text,
							source,
						}
						setMessageTags((current) =>
							current.some((existing) => sameMessageTag(existing, tag)) ? current : [...current, tag],
						)
						focusComposer()
					} else {
						insertRawUrl()
					}
				})
				.catch((error) => {
					console.error("Failed to resolve message link:", error)
					insertRawUrl()
				})
		},
		[setInputValue, setMessageTags, focusComposer],
	)

	return (
		<ChatTextArea
			enterSendsAs={enterSendsAs}
			hasQuotes={quotes.length > 0 || messageTags.length > 0}
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
			onOpenTaskGroup={onOpenTaskGroup}
			onPasteMessageLink={handlePasteMessageLink}
			onRestoreStash={handleRestoreStash}
			onScriptRun={chatState.setScriptRun}
			onSelectFilesAndImages={selectFilesAndImages}
			onSend={() => messageHandlers.handleSendMessage(inputValue, selectedImages, selectedFiles)}
			onSendAs={handleSendAs}
			onStash={handleStash}
			onThreadPicked={chatState.authorizeThread}
			placeholderText={isRunning ? runningPlaceholder : placeholderText}
			quoteTags={
				quotes.length > 0 || messageTags.length > 0 ? (
					<div className="flex items-center gap-1" data-testid="composer-chips">
						{messageTags.length > 0 && (
							<MessageTagList focusComposer={focusComposer} setTags={setMessageTags} tags={messageTags} />
						)}
						{quotes.length > 0 && (
							<div className="min-w-0 flex-1">
								<QuoteTagList
									autoOpenIndex={focusNewQuoteNote ? quotes.length - 1 : undefined}
									focusComposer={focusComposer}
									quotes={quotes}
									setQuotes={setQuotes}
								/>
							</div>
						)}
					</div>
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
							hasCompactNudge: showsCompactNudge(
								canCompact,
								contextUsagePercent(lastApiReqTotalTokens, usage.contextWindow),
							),
							render: ({ inlineCompactNudge }) => (
								<ContextUsageIndicator
									{...usage}
									autoCompact={useAutoCondense !== false}
									breakdown={costBreakdown}
									cacheReads={apiMetrics.totalCacheReads}
									cacheWrites={apiMetrics.totalCacheWrites}
									canCompact={canCompact}
									inlineCompactNudge={inlineCompactNudge}
									onCompact={() =>
										void messageHandlers
											.compactTask()
											.catch((err) => console.error("Failed to compact task:", err))
									}
									// The ring stands alone by the model chip; the cost is in its details.
									showCost={false}
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
