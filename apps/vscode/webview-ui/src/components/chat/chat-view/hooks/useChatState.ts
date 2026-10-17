import { ClineMessage } from "@shared/ExtensionMessage"
import { type Dispatch, type SetStateAction, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ChatState, type DraftSnapshot, PendingResponse, PendingUserMessage, type QuoteDraft } from "../types/chatTypes"
import { type DraftAuthorization, hasThreadToken, pruneAuthorization } from "../utils/composerProvenance"

const EMPTY_DRAFT: DraftSnapshot = {
	revision: 0,
	text: "",
	quotes: [],
	images: [],
	files: [],
	authorizedThreadIds: [],
}

function applyDraftFieldUpdate<Key extends "text" | "quotes" | "images" | "files">(
	draft: DraftSnapshot,
	key: Key,
	update: SetStateAction<DraftSnapshot[Key]>,
): DraftSnapshot {
	const value = typeof update === "function" ? update(draft[key]) : update
	const next = { ...draft, revision: draft.revision + 1, [key]: value }
	// Deleting a mention token or the script prefix revokes what the user picked for it.
	return key === "text" ? { ...next, ...pruneAuthorization(next.text, next) } : next
}

/**
 * Custom hook for managing chat state
 * Handles input values, selection states, and UI state
 */
export function useChatState(messages: ClineMessage[]): ChatState {
	// Input and selection state
	const [draft, setDraft] = useState(EMPTY_DRAFT)
	const draftRef = useRef(draft)
	const updateDraft = useCallback((update: (current: DraftSnapshot) => DraftSnapshot) => {
		const next = update(draftRef.current)
		draftRef.current = next
		setDraft(next)
	}, [])
	const setInputValue = useCallback<Dispatch<SetStateAction<string>>>(
		(update) => updateDraft((current) => applyDraftFieldUpdate(current, "text", update)),
		[updateDraft],
	)
	const setQuotes = useCallback<Dispatch<SetStateAction<QuoteDraft[]>>>(
		(update) => updateDraft((current) => applyDraftFieldUpdate(current, "quotes", update)),
		[updateDraft],
	)
	const addQuote = useCallback((text: string) => setQuotes((current) => [...current, { text, note: "" }]), [setQuotes])
	const setSelectedImages = useCallback<Dispatch<SetStateAction<string[]>>>(
		(update) => updateDraft((current) => applyDraftFieldUpdate(current, "images", update)),
		[updateDraft],
	)
	const setSelectedFiles = useCallback<Dispatch<SetStateAction<string[]>>>(
		(update) => updateDraft((current) => applyDraftFieldUpdate(current, "files", update)),
		[updateDraft],
	)
	const authorizeThread = useCallback(
		(threadId: string) =>
			updateDraft((current) =>
				hasThreadToken(current.text, threadId) && !current.authorizedThreadIds.includes(threadId)
					? { ...current, authorizedThreadIds: [...current.authorizedThreadIds, threadId] }
					: current,
			),
		[updateDraft],
	)
	const setScriptRun = useCallback(
		(scriptRun: DraftAuthorization["scriptRun"]) =>
			updateDraft((current) =>
				JSON.stringify(current.scriptRun) === JSON.stringify(scriptRun) ? current : { ...current, scriptRun },
			),
		[updateDraft],
	)
	const restoreAuthorization = useCallback(
		(auth: DraftAuthorization) =>
			updateDraft((current) => ({ ...current, ...pruneAuthorization(current.text, { ...current, ...auth }) })),
		[updateDraft],
	)
	const [isTextAreaFocused, setIsTextAreaFocused] = useState(false)
	const getDraftSnapshot = useCallback((): DraftSnapshot => draftRef.current, [])
	const consumeDraftSnapshot = useCallback(
		(submitted: DraftSnapshot) => {
			// A submission takes effect at acknowledgement. Clear the whole draft
			// only if no draft mutation crossed that await boundary.
			updateDraft((current) =>
				current.revision === submitted.revision ? { ...EMPTY_DRAFT, revision: current.revision + 1 } : current,
			)
		},
		[updateDraft],
	)

	// UI state
	const [sendingDisabled, setSendingDisabled] = useState(false)
	const [enableButtons, setEnableButtons] = useState<boolean>(false)
	const [primaryButtonText, setPrimaryButtonText] = useState<string | undefined>("Approve")
	const [secondaryButtonText, setSecondaryButtonText] = useState<string | undefined>("Reject")
	const [expandedRows, setExpandedRows] = useState<Record<number, boolean>>({})
	const [pendingUserMessage, setPendingUserMessage] = useState<PendingUserMessage | undefined>(undefined)
	const [pendingResponse, setPendingResponse] = useState<PendingResponse | undefined>(undefined)

	// Refs
	const textAreaRef = useRef<HTMLTextAreaElement>(null)

	// Derived state
	const lastMessage = useMemo(() => messages.at(-1), [messages])
	const secondLastMessage = useMemo(() => messages.at(-2), [messages])
	const clineAsk = useMemo(() => (lastMessage?.type === "ask" ? lastMessage.ask : undefined), [lastMessage])

	// Clear expanded rows when task changes
	const task = useMemo(() => messages.at(0), [messages])
	const clearExpandedRows = useCallback(() => {
		setExpandedRows({})
	}, [])

	// Reset state when starting new conversation
	const resetState = useCallback(() => {
		setInputValue("")
		setQuotes([])
		setSelectedImages([])
		setSelectedFiles([])
	}, [setInputValue, setQuotes, setSelectedImages, setSelectedFiles])

	// Handle focus change
	const handleFocusChange = useCallback((isFocused: boolean) => {
		setIsTextAreaFocused(isFocused)
	}, [])

	// Auto-expand last message row when task or messages first changed.
	useEffect(() => {
		clearExpandedRows()
	}, [task?.ts, clearExpandedRows])

	return {
		// State values
		inputValue: draft.text,
		setInputValue,
		quotes: draft.quotes,
		setQuotes,
		addQuote,
		isTextAreaFocused,
		setIsTextAreaFocused,
		selectedImages: draft.images,
		setSelectedImages,
		selectedFiles: draft.files,
		setSelectedFiles,
		getDraftSnapshot,
		authorizeThread,
		setScriptRun,
		restoreAuthorization,
		consumeDraftSnapshot,
		sendingDisabled,
		setSendingDisabled,
		enableButtons,
		setEnableButtons,
		primaryButtonText,
		setPrimaryButtonText,
		secondaryButtonText,
		setSecondaryButtonText,
		expandedRows,
		setExpandedRows,
		pendingUserMessage,
		setPendingUserMessage,
		pendingResponse,
		setPendingResponse,

		// Refs
		textAreaRef,

		// Derived values
		lastMessage,
		secondLastMessage,
		clineAsk,
		task,

		// Handlers
		handleFocusChange,
		clearExpandedRows,
		resetState,
	}
}
