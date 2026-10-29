import { combineApiRequests } from "@shared/combineApiRequests"
import { combineCommandSequences } from "@shared/combineCommandSequences"
import { combineHookSequences } from "@shared/combineHookSequences"
import { getApiMetrics, getCostBreakdown, getLastApiReqTotalTokens } from "@shared/getApiMetrics"
import { BooleanRequest, StringRequest } from "@shared/proto/cline/common"
import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useMount } from "react-use"
import { openTask } from "@/components/inbox/sessionActions"
import { useNavigationHistory } from "@/components/navigation/NavigationHistoryContext"
import { NewChatHero, NewChatListToggle } from "@/components/oneView/NewChatHero"
import { OneViewLayout } from "@/components/oneView/OneViewLayout"
import { SearchView } from "@/components/search/SearchView"
import { useClearComposerTaskOnLeavingTask } from "@/components/taskGroup/composerTaskGroup"
import { NotebookView } from "@/components/taskGroup/NotebookView"
import { TaskGroupView } from "@/components/taskGroup/TaskGroupView"
import { useTaskGroupPageNavigation } from "@/components/taskGroup/useTaskGroup"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useShowNavbar } from "@/context/PlatformContext"
import { useNormalizedApiConfiguration } from "@/hooks/useNormalizedApiConfiguration"
import { cn } from "@/lib/utils"
import { FileServiceClient, UiServiceClient } from "@/services/grpc-client"
import { Navbar } from "../menu/Navbar"
// Import utilities and hooks from the new structure
import {
	ActionButtons,
	CHAT_CONSTANTS,
	ChatLayout,
	convertHtmlToMarkdown,
	filterVisibleMessages,
	groupLowStakesTools,
	groupMessages,
	InputSection,
	MessagesArea,
	QueuedPrompts,
	TaskSection,
	ThreadStrip,
	useChatState,
	useMessageHandlers,
	useScrollBehavior,
	WelcomeSection,
	withTaskMessage,
} from "./chat-view"
import { SubagentThreadFooter, SubagentThreadHeader } from "./chat-view/components/layout/SubagentThreadHeader"
import { findOpenMessageIndex } from "./chat-view/utils/openMessageUtils"
import {
	hasPendingMessageConfirmation,
	isPendingResponseUnconfirmed,
	withPendingUserMessage,
} from "./chat-view/utils/pendingResponse"
import { subagentReportText } from "./chat-view/utils/subagentReport"
import type { LineageRow } from "./chat-view/utils/threadUtils"
import { clearSubagentExpandTarget, emitSubagentExpand } from "./subagentExpand"

interface ChatViewProps {
	isHidden: boolean
	showAnnouncement: boolean
	hideAnnouncement: () => void
	showHistoryView: () => void
}

// Use constants from the imported module
const MAX_IMAGES_AND_FILES_PER_MESSAGE = CHAT_CONSTANTS.MAX_IMAGES_AND_FILES_PER_MESSAGE
const QUICK_WINS_HISTORY_THRESHOLD = 3

const ChatView = ({ isHidden, showAnnouncement, hideAnnouncement, showHistoryView }: ChatViewProps) => {
	const showNavbar = useShowNavbar()
	const {
		version,
		clineMessages: messages,
		taskHistory,
		telemetrySetting,
		mode,
		userInfo,
		hooksEnabled,
		checkpointRestoreInput,
		queuedPrompts,
		turnState,
		subagentView,
		currentTaskItem,
		taskGroupView,
		oneViewEnabled,
		hideTaskGroupView,
	} = useExtensionState()
	const isProdHostedApp = userInfo?.apiBaseUrl === "https://app.cline.bot"
	const shouldShowQuickWins = isProdHostedApp && (!taskHistory || taskHistory.length < QUICK_WINS_HISTORY_THRESHOLD)

	// Use custom hooks for state management
	const chatState = useChatState(messages)
	const {
		setInputValue,
		selectedImages,
		setSelectedImages,
		selectedFiles,
		setSelectedFiles,
		sendingDisabled,
		enableButtons,
		expandedRows,
		setExpandedRows,
		pendingUserMessage,
		setPendingUserMessage,
		pendingResponse,
		setPendingResponse,
		textAreaRef,
	} = chatState

	const [childQuotes, setChildQuotes] = useState<Record<string, string[]>>({})
	const selectedChildQuotes = childQuotes[currentTaskItem?.id ?? ""] ?? []
	const pendingParentQuote = useRef<{ parentTaskId: string; text: string } | undefined>(undefined)
	useEffect(() => {
		const pending = pendingParentQuote.current
		if (pending && currentTaskItem?.id === pending.parentTaskId) {
			pendingParentQuote.current = undefined
			chatState.setQuotes((quotes) => [...quotes, { text: pending.text, note: "" }])
		}
	}, [currentTaskItem?.id, chatState.setQuotes])
	const report = subagentReportText(messages)
	const quoteIntoParent = () => {
		if (!subagentView) return
		const selected = selectedChildQuotes.join("\n\n")
		pendingParentQuote.current = { parentTaskId: subagentView.parentTaskId, text: selected || report }
		void openTask(subagentView.parentTaskId)
	}

	const displayMessages = useMemo(() => withPendingUserMessage(messages, pendingUserMessage), [messages, pendingUserMessage])

	useEffect(() => {
		if (pendingUserMessage && hasPendingMessageConfirmation(messages, pendingUserMessage)) {
			setPendingUserMessage((current) => (current === pendingUserMessage ? undefined : current))
		}
	}, [messages, pendingUserMessage, setPendingUserMessage])

	useEffect(() => {
		if (!pendingResponse || isPendingResponseUnconfirmed(pendingResponse, turnState, messages.length)) {
			return
		}
		setPendingResponse((current) => (current?.id === pendingResponse.id ? undefined : current))
	}, [messages.length, pendingResponse, setPendingResponse, turnState])

	//const task = messages.length > 0 ? (messages[0].say === "task" ? messages[0] : undefined) : undefined) : undefined
	const task = useMemo(() => displayMessages.at(0), [displayMessages]) // leaving this less safe version here since if the first message is not a task, then the extension is in a bad state and needs to be debugged (see Cline.abort)
	const modifiedMessages = useMemo(() => {
		const slicedMessages = displayMessages.slice(1)
		// Only combine hook sequences if hooks are enabled
		const withHooks = hooksEnabled ? combineHookSequences(slicedMessages) : slicedMessages
		return combineApiRequests(combineCommandSequences(withHooks))
	}, [displayMessages, hooksEnabled])
	// has to be after api_req_finished are all reduced into api_req_started messages
	const apiMetrics = useMemo(() => getApiMetrics(modifiedMessages), [modifiedMessages])
	const costBreakdown = useMemo(() => getCostBreakdown(modifiedMessages), [modifiedMessages])

	const lastApiReqTotalTokens = useMemo(() => getLastApiReqTotalTokens(modifiedMessages) || undefined, [modifiedMessages])
	const lastAppliedCheckpointRestoreSessionId = useRef<string | undefined>(checkpointRestoreInput?.sessionId)

	useEffect(() => {
		if (!checkpointRestoreInput || checkpointRestoreInput.sessionId === lastAppliedCheckpointRestoreSessionId.current) {
			return
		}
		lastAppliedCheckpointRestoreSessionId.current = checkpointRestoreInput.sessionId
		setInputValue(checkpointRestoreInput.text)
		setSelectedImages(checkpointRestoreInput.images ?? [])
		setSelectedFiles(checkpointRestoreInput.files ?? [])
		setTimeout(() => {
			textAreaRef.current?.focus()
		}, 0)
	}, [checkpointRestoreInput, setInputValue, setSelectedImages, setSelectedFiles, textAreaRef])

	useEffect(() => {
		const handleCopy = async (e: ClipboardEvent) => {
			const targetElement = e.target as HTMLElement | null
			// If the copy event originated from an input or textarea,
			// let the default browser behavior handle it.
			if (
				targetElement &&
				(targetElement.tagName === "INPUT" || targetElement.tagName === "TEXTAREA" || targetElement.isContentEditable)
			) {
				return
			}

			if (window.getSelection) {
				const selection = window.getSelection()
				if (selection && selection.rangeCount > 0) {
					const range = selection.getRangeAt(0)
					const commonAncestor = range.commonAncestorContainer
					let textToCopy: string | null = null

					// Check if the selection is inside an element where plain text copy is preferred
					let currentElement =
						commonAncestor.nodeType === Node.ELEMENT_NODE
							? (commonAncestor as HTMLElement)
							: commonAncestor.parentElement
					let preferPlainTextCopy = false
					while (currentElement) {
						if (currentElement.tagName === "PRE" && currentElement.querySelector("code")) {
							preferPlainTextCopy = true
							break
						}
						// Check computed white-space style
						const computedStyle = window.getComputedStyle(currentElement)
						if (
							computedStyle.whiteSpace === "pre" ||
							computedStyle.whiteSpace === "pre-wrap" ||
							computedStyle.whiteSpace === "pre-line"
						) {
							// If the element itself or an ancestor has pre-like white-space,
							// and the selection is likely contained within it, prefer plain text.
							// This helps with elements like the TaskHeader's text display.
							preferPlainTextCopy = true
							break
						}

						// Stop searching if we reach a known chat message boundary or body
						if (
							currentElement.classList.contains("chat-row-assistant-message-container") ||
							currentElement.classList.contains("chat-row-user-message-container") ||
							currentElement.tagName === "BODY"
						) {
							break
						}
						currentElement = currentElement.parentElement
					}

					if (preferPlainTextCopy) {
						// For code blocks or elements with pre-formatted white-space, get plain text.
						textToCopy = selection.toString()
					} else {
						// For other content, use the existing HTML-to-Markdown conversion
						const clonedSelection = range.cloneContents()
						const div = document.createElement("div")
						div.appendChild(clonedSelection)
						const selectedHtml = div.innerHTML
						textToCopy = await convertHtmlToMarkdown(selectedHtml)
					}

					if (textToCopy !== null) {
						try {
							FileServiceClient.copyToClipboard(StringRequest.create({ value: textToCopy })).catch((err) => {
								console.error("Error copying to clipboard:", err)
							})
							e.preventDefault()
						} catch (error) {
							console.error("Error copying to clipboard:", error)
						}
					}
				}
			}
		}
		document.addEventListener("copy", handleCopy)

		return () => {
			document.removeEventListener("copy", handleCopy)
		}
	}, [])
	// Button state is now managed by useButtonState hook

	// handleFocusChange is already provided by chatState

	// Use message handlers hook
	const messageHandlers = useMessageHandlers(messages, chatState)

	const { selectedModelInfo } = useNormalizedApiConfiguration(mode, true)

	const selectFilesAndImages = useCallback(async () => {
		try {
			const response = await FileServiceClient.selectFiles(
				BooleanRequest.create({
					value: selectedModelInfo.supportsImages,
				}),
			)
			if (
				response &&
				response.values1 &&
				response.values2 &&
				(response.values1.length > 0 || response.values2.length > 0)
			) {
				const currentTotal = selectedImages.length + selectedFiles.length
				const availableSlots = MAX_IMAGES_AND_FILES_PER_MESSAGE - currentTotal

				if (availableSlots > 0) {
					// Prioritize images first
					const imagesToAdd = Math.min(response.values1.length, availableSlots)
					if (imagesToAdd > 0) {
						setSelectedImages((prevImages) => [...prevImages, ...response.values1.slice(0, imagesToAdd)])
					}

					// Use remaining slots for files
					const remainingSlots = availableSlots - imagesToAdd
					if (remainingSlots > 0) {
						setSelectedFiles((prevFiles) => [...prevFiles, ...response.values2.slice(0, remainingSlots)])
					}
				}
			}
		} catch (error) {
			console.error("Error selecting images & files:", error)
		}
	}, [selectedModelInfo.supportsImages])

	const shouldDisableFilesAndImages = selectedImages.length + selectedFiles.length >= MAX_IMAGES_AND_FILES_PER_MESSAGE

	// Subscribe to show webview events from the backend
	useEffect(() => {
		const cleanup = UiServiceClient.subscribeToShowWebview(
			{},
			{
				onResponse: (event: any) => {
					// Only focus if not hidden and preserveEditorFocus is false
					if (!isHidden && !event.preserveEditorFocus) {
						textAreaRef.current?.focus()
					}
				},
				onError: (error: any) => {
					console.error("Error in showWebview subscription:", error)
				},
				onComplete: () => {
					console.log("showWebview subscription completed")
				},
			},
		)

		return cleanup
	}, [isHidden])

	// Set up addToInput subscription
	useEffect(() => {
		const cleanup = UiServiceClient.subscribeToAddToInput(
			{},
			{
				onResponse: (event: any) => {
					if (event.value) {
						setInputValue((prevValue) => {
							const newText = event.value
							const newTextWithNewline = newText + "\n"
							return prevValue ? `${prevValue}\n${newTextWithNewline}` : newTextWithNewline
						})
						// Add scroll to bottom after state update
						// Auto focus the input and start the cursor on a new line for easy typing
						setTimeout(() => {
							if (textAreaRef.current) {
								textAreaRef.current.scrollTop = textAreaRef.current.scrollHeight
								textAreaRef.current.focus()
							}
						}, 0)
					}
				},
				onError: (error: any) => {
					console.error("Error in addToInput subscription:", error)
				},
				onComplete: () => {
					console.log("addToInput subscription completed")
				},
			},
		)

		return cleanup
	}, [])

	useMount(() => {
		// NOTE: the vscode window needs to be focused for this to work
		textAreaRef.current?.focus()
	})

	useEffect(() => {
		const timer = setTimeout(() => {
			if (!isHidden && !sendingDisabled && !enableButtons) {
				textAreaRef.current?.focus()
			}
		}, 50)
		return () => {
			clearTimeout(timer)
		}
	}, [isHidden, sendingDisabled, enableButtons])

	// The first message renders as the conversation's first user bubble. It joins the list only
	// after combining, so it never reaches the metrics/combine helpers above.
	const visibleMessages = useMemo(
		() => withTaskMessage(task, filterVisibleMessages(modifiedMessages)),
		[task, modifiedMessages],
	)

	const groupedMessages = useMemo(() => {
		return groupLowStakesTools(groupMessages(visibleMessages))
	}, [visibleMessages])

	// Use scroll behavior hook
	const scrollBehavior = useScrollBehavior(displayMessages, visibleMessages, groupedMessages, expandedRows, setExpandedRows)
	const { scrollToBottomSmooth, scrollToBottomAuto, disableAutoScrollRef } = scrollBehavior

	// A vscode:// message deep link: scroll to the message once its thread is
	// loaded, then briefly flash the row. Matched by the stable transcript
	// index; the message text is the fallback for unindexed rows.
	const { openMessageTarget, clearOpenMessageTarget } = useExtensionState()
	useEffect(() => {
		if (!openMessageTarget || currentTaskItem?.id !== openMessageTarget.threadId) {
			return
		}
		const index = findOpenMessageIndex(displayMessages, openMessageTarget)
		if (index < 0) {
			return // thread still loading — retry on the next messages update
		}
		const ts = displayMessages[index].ts
		scrollBehavior.scrollToMessage(index)
		clearOpenMessageTarget()
		// Flash once the row is rendered (Virtuoso mounts it after the scroll).
		// No effect cleanup for this timer: clearing the target re-runs the effect,
		// which would cancel the flash before the row mounts. It stops itself.
		let tries = 0
		const flash = setInterval(() => {
			const el = scrollBehavior.scrollContainerRef.current?.querySelector<HTMLElement>(`[data-message-ts="${ts}"]`)
			if (el || ++tries > 20) {
				clearInterval(flash)
				el?.classList.add("message-link-flash")
				setTimeout(() => el?.classList.remove("message-link-flash"), 1800)
			}
		}, 100)
	}, [openMessageTarget, currentTaskItem?.id, displayMessages, scrollBehavior, clearOpenMessageTarget])

	// A transcript-only subagent row in the header's subagent panel scrolls the
	// transcript to that subagent's status row and expands its details there.
	const openSubagentDetails = useCallback(
		(item: LineageRow) => {
			const [tsText, indexText] = item.id.split(":")
			const ts = Number(tsText)
			const itemIndex = Number(indexText)
			if (!Number.isFinite(ts) || !Number.isFinite(itemIndex)) {
				return
			}
			const messageIndex = displayMessages.findIndex((message) => message.ts === ts)
			if (messageIndex >= 0) {
				scrollBehavior.scrollToMessage(messageIndex)
			}
			emitSubagentExpand(ts, itemIndex)
		},
		[displayMessages, scrollBehavior],
	)

	// When a prompt gets queued, the queue banner mounts (or grows) in the footer, which
	// shrinks the messages area and visually covers the bottom of the conversation. No new
	// chat row is added, so the list-length-based auto-scroll never fires — re-pin to the
	// bottom here so the latest content stays visible.
	const queuedPromptCount = queuedPrompts?.length ?? 0
	const taskTs = task?.ts
	// A pending subagent-expand target belongs to the task it was requested in;
	// drop it on a task switch so it can't expand a row in another conversation.
	useEffect(() => {
		clearSubagentExpandTarget()
	}, [taskTs])
	const prevQueuedPromptCountRef = useRef(queuedPromptCount)
	const prevQueuedPromptTaskTsRef = useRef(taskTs)
	useEffect(() => {
		const previousCount = prevQueuedPromptCountRef.current
		const previousTaskTs = prevQueuedPromptTaskTsRef.current
		prevQueuedPromptCountRef.current = queuedPromptCount
		prevQueuedPromptTaskTsRef.current = taskTs
		// A task switch can grow the count without a send from this webview (the newly
		// displayed task may already have queued prompts) — don't hijack its scroll position.
		if (taskTs !== previousTaskTs || queuedPromptCount <= previousCount) {
			return
		}
		// Queueing is a deliberate send, so re-engage bottom pinning like handleSendMessage does.
		disableAutoScrollRef.current = false
		scrollToBottomSmooth()
		// Settle with an instant scroll once the footer's layout change has landed.
		setTimeout(() => {
			if (!disableAutoScrollRef.current) {
				scrollToBottomAuto()
			}
		}, 50)
	}, [queuedPromptCount, taskTs, scrollToBottomSmooth, scrollToBottomAuto, disableAutoScrollRef])

	// Home's search view, carrying over what was typed in the search bar. null = closed.
	const [searchQuery, setSearchQuery] = useState<string | null>(null)
	const openSearch = useCallback((query: string) => setSearchQuery(query), [])
	const closeSearch = useCallback(() => setSearchQuery(null), [])
	const showSearch = !task && searchQuery !== null
	// Back history needs ChatView's thread and search state; lend it the controls.
	const navigation = useNavigationHistory()
	const registerChatNavigation = navigation?.registerChat
	const reportSearch = navigation?.reportSearch
	const closeThread = messageHandlers.handleTaskCloseButtonClick
	useEffect(
		() => registerChatNavigation?.({ closeThread: () => void closeThread(), openSearch, closeSearch }),
		[registerChatNavigation, closeThread, openSearch, closeSearch],
	)
	useEffect(() => reportSearch?.(showSearch), [reportSearch, showSearch])
	// Opening a thread from anywhere leaves search; coming home lands on home, not stale results.
	useEffect(() => {
		if (taskTs !== undefined) setSearchQuery(null)
	}, [taskTs])

	// The task (group) page replaces chat/home in the sidebar.
	const openTaskGroup = useTaskGroupPageNavigation({
		taskTs,
		closeThread: messageHandlers.handleTaskCloseButtonClick,
		onPageOpen: closeSearch,
	})

	useClearComposerTaskOnLeavingTask(taskGroupView?.id ?? currentTaskItem?.taskGroupId)

	// One view: ✎ New / the new-task shortcut open a new chat; Esc in an empty one returns to the last thread.
	const lastThreadIdRef = useRef<string | undefined>(undefined)
	useEffect(() => {
		if (currentTaskItem?.id) lastThreadIdRef.current = currentTaskItem.id
	}, [currentTaskItem?.id])
	const openNewChat = useCallback(() => {
		if (taskGroupView) hideTaskGroupView()
		if (task) void messageHandlers.startNewTask()
		setTimeout(() => textAreaRef.current?.focus(), 0)
	}, [taskGroupView, hideTaskGroupView, task, messageHandlers.startNewTask, textAreaRef])
	const openThreadFromList = useCallback(
		(threadId: string) => {
			if (threadId === currentTaskItem?.id && !taskGroupView) return
			void openTask(threadId)
		},
		[currentTaskItem?.id, taskGroupView],
	)
	const returnOnEscape = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key !== "Escape" || event.defaultPrevented || task || taskGroupView) return
		if (event.target !== textAreaRef.current && event.target !== event.currentTarget) return
		const hasDraft =
			!!chatState.inputValue.trim() ||
			selectedImages.length > 0 ||
			selectedFiles.length > 0 ||
			chatState.quotes.length > 0 ||
			(chatState.messageTags?.length ?? 0) > 0
		const previous = lastThreadIdRef.current
		if (hasDraft || !previous || !taskHistory?.some((item) => item.id === previous)) return
		event.preventDefault()
		void openTask(previous)
	}

	const placeholderText = useMemo(() => {
		if (taskGroupView && !task) return "New thread in this task…"
		const text = task ? "Type a message..." : "Type your task here..."
		return text
	}, [task, taskGroupView])

	const messagesArea = task && !taskGroupView && (
		<MessagesArea
			chatState={chatState}
			groupedMessages={groupedMessages}
			messageHandlers={messageHandlers}
			modifiedMessages={modifiedMessages}
			onSetQuote={
				subagentView && currentTaskItem
					? (text) =>
							setChildQuotes((quotes) => ({
								...quotes,
								[currentTaskItem.id]: [...(quotes[currentTaskItem.id] ?? []), text],
							}))
					: undefined
			}
			scrollBehavior={scrollBehavior}
			task={task}
		/>
	)

	const composerControls = (
		<>
			{(!subagentView || subagentView.pendingDecision === "approval") && (
				<ActionButtons
					chatState={chatState}
					messageHandlers={messageHandlers}
					messages={messages}
					mode={mode}
					task={task}
				/>
			)}
			{!subagentView && <QueuedPrompts items={queuedPrompts} />}
			{(!subagentView || subagentView.pendingDecision === "question") && (
				<InputSection
					apiMetrics={apiMetrics}
					chatState={chatState}
					costBreakdown={costBreakdown}
					lastApiReqTotalTokens={lastApiReqTotalTokens}
					messageHandlers={messageHandlers}
					onOpenTaskGroup={openTaskGroup}
					placeholderText={placeholderText}
					scrollBehavior={scrollBehavior}
					selectFilesAndImages={selectFilesAndImages}
					shouldDisableFilesAndImages={shouldDisableFilesAndImages}
				/>
			)}
			{subagentView && (
				<SubagentThreadFooter hasReport={!!report || selectedChildQuotes.length > 0} onQuote={quoteIntoParent} />
			)}
		</>
	)

	if (oneViewEnabled) {
		// The list is home: no thread and no task page is the new-chat screen.
		const isNewChat = !task && !taskGroupView
		return (
			<OneViewLayout
				currentTaskGroupId={taskGroupView?.id}
				currentThreadId={currentTaskItem?.id}
				hidden={isHidden}
				onNewChat={openNewChat}
				onOpenTaskGroup={openTaskGroup}
				onOpenThread={openThreadFromList}>
				{/* biome-ignore lint/a11y/noStaticElementInteractions: Esc in an empty new chat returns to the last thread */}
				<div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" onKeyDown={returnOnEscape}>
					{showNavbar && <Navbar startNewTask={messageHandlers.startNewTask} />}
					{/* Fixed slots (top, composer, spacer) so the composer never remounts between a new chat and a thread. */}
					<div
						className={cn("flex min-h-0 flex-1 flex-col", isNewChat ? "justify-end" : "overflow-hidden")}
						data-testid={isNewChat ? "one-view-new-chat" : "one-view-content"}>
						{isNewChat ? (
							<>
								<NewChatListToggle />
								<NewChatHero />
							</>
						) : (
							<>
								{taskGroupView ? (
									taskGroupView.page === "notebook" ? (
										<NotebookView key={taskGroupView.id} taskGroupId={taskGroupView.id} />
									) : (
										<TaskGroupView key={taskGroupView.id} taskGroupId={taskGroupView.id} />
									)
								) : subagentView && currentTaskItem ? (
									<SubagentThreadHeader
										item={currentTaskItem}
										onOpenSubagentPreview={openSubagentDetails}
										view={subagentView}
									/>
								) : (
									task && (
										<TaskSection
											messageHandlers={messageHandlers}
											onOpenSubagentPreview={openSubagentDetails}
											onOpenTaskGroup={openTaskGroup}
											task={task}
										/>
									)
								)}
								{task && !subagentView && !taskGroupView && <ThreadStrip />}
								{messagesArea}
							</>
						)}
					</div>
					<footer
						className={cn(
							"flex shrink-0 flex-col bg-(--vscode-sidebar-background)",
							isNewChat && "mx-auto w-full max-w-[680px]",
							taskGroupView?.page === "notebook" && "hidden",
						)}
						data-testid="one-view-composer">
						{composerControls}
					</footer>
					<div aria-hidden className={isNewChat ? "min-h-0 flex-1" : "hidden"} />
				</div>
			</OneViewLayout>
		)
	}

	return (
		<ChatLayout isHidden={isHidden}>
			<div className="flex flex-col flex-1 overflow-hidden">
				{showNavbar && <Navbar startNewTask={messageHandlers.startNewTask} />}
				{taskGroupView ? (
					taskGroupView.page === "notebook" ? (
						<NotebookView key={taskGroupView.id} taskGroupId={taskGroupView.id} />
					) : (
						<TaskGroupView key={taskGroupView.id} taskGroupId={taskGroupView.id} />
					)
				) : subagentView && currentTaskItem ? (
					<SubagentThreadHeader
						item={currentTaskItem}
						onOpenSubagentPreview={openSubagentDetails}
						view={subagentView}
					/>
				) : task ? (
					<TaskSection
						messageHandlers={messageHandlers}
						onOpenSubagentPreview={openSubagentDetails}
						onOpenTaskGroup={openTaskGroup}
						task={task}
					/>
				) : showSearch ? (
					<SearchView initialQuery={searchQuery ?? ""} onClose={closeSearch} />
				) : (
					<WelcomeSection
						hideAnnouncement={hideAnnouncement}
						onOpenSearch={openSearch}
						onOpenTaskGroup={openTaskGroup}
						shouldShowQuickWins={shouldShowQuickWins}
						showAnnouncement={showAnnouncement}
						showHistoryView={showHistoryView}
						taskHistory={taskHistory}
						telemetrySetting={telemetrySetting}
						version={version}
					/>
				)}
				{task && !subagentView && !taskGroupView && <ThreadStrip />}
				{messagesArea}
			</div>
			<footer
				className={cn(
					"bg-(--vscode-sidebar-background) flex flex-col",
					(showSearch || taskGroupView?.page === "notebook") && "hidden",
				)}
				style={{ gridRow: "2" }}>
				{composerControls}
			</footer>
		</ChatLayout>
	)
}

export default ChatView
