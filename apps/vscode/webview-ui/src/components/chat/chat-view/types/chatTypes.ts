/**
 * Shared types and interfaces for the chat view components
 */

import { ClineAsk, ClineMessage } from "@shared/ExtensionMessage"
import { ListRange, VirtuosoHandle } from "react-virtuoso"
import type { ButtonActionType, SubmittingButtonActionType } from "../shared/buttonConfig"
import type { DraftAuthorization } from "../utils/composerProvenance"

/** A passage quoted from the conversation, with an optional note typed under it. */
export interface QuoteDraft {
	text: string
	note: string
	/**
	 * Optional attribution shown on the chip and prepended to the sent quote,
	 * e.g. "You · Dev plan" for a pasted message link.
	 */
	source?: string
}

/**
 * A message pasted into the composer as a link: a context connection, not a
 * quote. It carries the link's target so the host can resolve the text when the
 * message is sent, plus what the chip and its hover card show.
 */
export interface MessageTagDraft {
	threadId: string
	messageIndex: number
	toolCallId?: string
	block?: number
	/** The linked message's text as resolved at paste time (shown on hover). */
	text: string
	/** Attribution shown on the chip, e.g. "You · Dev plan". */
	source: string
}

export interface DraftSnapshot extends DraftAuthorization {
	revision: number
	text: string
	quotes: QuoteDraft[]
	messageTags: MessageTagDraft[]
	images: string[]
	files: string[]
}

export type ButtonActionInvocation =
	| { type: SubmittingButtonActionType; draft: DraftSnapshot }
	| { type: Exclude<ButtonActionType, SubmittingButtonActionType>; draft?: never }

export interface PendingUserMessage {
	message: ClineMessage
	afterTs: number
}

export interface PendingResponse {
	/** Locally unique submission id, used to avoid an older RPC clearing newer state. */
	id: number
	/** TurnState sequence observed when the RPC was sent. */
	turnStateSeq: number | undefined
	/** Raw backend message count observed when the RPC was sent (legacy fallback). */
	messageCount: number
}

/**
 * Chat state interface
 */
export interface ChatState {
	// State values
	inputValue: string
	setInputValue: React.Dispatch<React.SetStateAction<string>>
	quotes: QuoteDraft[]
	setQuotes: React.Dispatch<React.SetStateAction<QuoteDraft[]>>
	messageTags: MessageTagDraft[]
	setMessageTags: React.Dispatch<React.SetStateAction<MessageTagDraft[]>>
	/** Appends a quote with an empty note. */
	addQuote: (text: string) => void
	isTextAreaFocused: boolean
	setIsTextAreaFocused: React.Dispatch<React.SetStateAction<boolean>>
	selectedImages: string[]
	setSelectedImages: React.Dispatch<React.SetStateAction<string[]>>
	selectedFiles: string[]
	setSelectedFiles: React.Dispatch<React.SetStateAction<string[]>>
	getDraftSnapshot: () => DraftSnapshot
	/** Records a thread the user picked from the `thread:` mention menu; ignored unless its token is in the text. */
	authorizeThread: (threadId: string) => void
	/** Records the script run the user typed or picked in the composer (undefined when none). */
	setScriptRun: (scriptRun: DraftAuthorization["scriptRun"]) => void
	/** Puts back the explicit grants of a draft whose send failed and was restored. */
	restoreAuthorization: (auth: DraftAuthorization) => void
	consumeDraftSnapshot: (draft: DraftSnapshot) => void
	sendingDisabled: boolean
	setSendingDisabled: React.Dispatch<React.SetStateAction<boolean>>
	enableButtons: boolean
	setEnableButtons: React.Dispatch<React.SetStateAction<boolean>>
	primaryButtonText: string | undefined
	setPrimaryButtonText: React.Dispatch<React.SetStateAction<string | undefined>>
	secondaryButtonText: string | undefined
	setSecondaryButtonText: React.Dispatch<React.SetStateAction<string | undefined>>
	expandedRows: Record<number, boolean>
	setExpandedRows: React.Dispatch<React.SetStateAction<Record<number, boolean>>>
	pendingUserMessage: PendingUserMessage | undefined
	setPendingUserMessage: React.Dispatch<React.SetStateAction<PendingUserMessage | undefined>>
	pendingResponse: PendingResponse | undefined
	setPendingResponse: React.Dispatch<React.SetStateAction<PendingResponse | undefined>>

	// Refs
	textAreaRef: React.RefObject<HTMLTextAreaElement>

	// Derived values
	lastMessage: ClineMessage | undefined
	secondLastMessage: ClineMessage | undefined
	clineAsk: ClineAsk | undefined
	task: ClineMessage | undefined

	// Handlers
	handleFocusChange: (isFocused: boolean) => void
	clearExpandedRows: () => void
	resetState: () => void

	// Scroll-related state (will be moved to scroll hook)
	isAtBottom?: boolean
	pendingScrollToMessage?: number | null
}

/**
 * Message handlers interface
 */
export interface MessageHandlers {
	errorRecoveryAvailable: boolean
	recoveryActionInFlight: boolean
	compactTask: () => Promise<boolean>
	executeButtonAction: (invocation: ButtonActionInvocation) => Promise<boolean>
	handleSendMessage: (text: string, images: string[], files: string[]) => Promise<void>
	/** Starts the draft as a NEW chat that runs in the background (home composer). */
	handleSendInBackground: (text: string, images: string[], files: string[]) => Promise<void>
	/** Stops the focused task's current turn and sends the draft immediately. */
	handleInterject: (text: string, images: string[], files: string[]) => Promise<void>
	/** Forks the focused task at `messageTs` (default: latest message) and sends the draft there. */
	handleAside: (text: string, images: string[], files: string[], messageTs?: number) => Promise<void>
	handleTaskCloseButtonClick: () => void
	retryFailedRequest: () => Promise<boolean>
	startNewTask: (source?: "chat_new_task" | "navbar") => Promise<boolean>
}

/**
 * Scroll behavior interface
 */
export interface ScrollBehavior {
	virtuosoRef: React.RefObject<VirtuosoHandle>
	scrollContainerRef: React.RefObject<HTMLDivElement>
	disableAutoScrollRef: React.MutableRefObject<boolean>
	scrollToBottomSmooth: () => void
	scrollToBottomAuto: () => void
	scrollToMessage: (messageIndex: number) => void
	/** Scrolls so the row at `groupIndex` (index into the rendered list) is at the top. */
	scrollToIndex: (groupIndex: number) => void
	toggleRowExpansion: (ts: number, options?: { preserveAutoScroll?: boolean }) => void
	handleRowHeightChange: (isTaller: boolean) => void
	handleLastRowContentChange: () => void
	isAtBottom: boolean
	setIsAtBottom: React.Dispatch<React.SetStateAction<boolean>>
	pendingScrollToMessage: number | null
	setPendingScrollToMessage: React.Dispatch<React.SetStateAction<number | null>>
	scrolledPastUserMessage: ClineMessage | null
	handleRangeChanged: (range: ListRange) => void
	/** Virtuoso's atBottomStateChange: tracks the bottom and resumes auto-follow when appropriate. */
	handleAtBottomStateChange: (atBottom: boolean) => void
}

/**
 * Welcome section props
 */
export interface WelcomeSectionProps {
	showAnnouncement: boolean
	hideAnnouncement: () => void
	showHistoryView: () => void
	telemetrySetting: string
	version: string
	taskHistory: any[]
	shouldShowQuickWins: boolean
	/** Opens the search view from the home search bar. */
	onOpenSearch: (query: string) => void
	/** Opens a task group's page from an inbox group row. */
	onOpenTaskGroup: (taskGroupId: string) => void
}
