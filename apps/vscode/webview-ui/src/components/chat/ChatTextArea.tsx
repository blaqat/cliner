import { mentionRegex, mentionRegexGlobal } from "@shared/context-mentions"
import { type ParsedMessageLink, parseMessageLink } from "@shared/message-links"
import { StringRequest } from "@shared/proto/cline/common"
import { FileSearchRequest, FileSearchType, RelativePathsRequest } from "@shared/proto/cline/file"
import { PlanActMode, TogglePlanActModeRequest } from "@shared/proto/cline/state"
import type { ScriptValues } from "@shared/scripts"
import { type SlashCommand } from "@shared/slashCommands"
import { Mode } from "@shared/storage/types"
import { SendHorizontalIcon, SendToBackIcon, TriangleAlertIcon, ZapIcon } from "lucide-react"
import type React from "react"
import { forwardRef, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import DynamicTextArea from "react-textarea-autosize"
import styled, { css, keyframes } from "styled-components"
import ContextMenu from "@/components/chat/ContextMenu"
import { CHAT_CONSTANTS } from "@/components/chat/chat-view/constants"
import SlashCommandMenu from "@/components/chat/SlashCommandMenu"
import Thumbnails from "@/components/common/Thumbnails"
import ScriptHelper from "@/components/scripts/ScriptHelper"
import { completeScriptInput, isScriptInputSendable, matchScriptInput, scriptRunOf } from "@/components/scripts/scriptInput"
import { getModeSpecificFields } from "@/components/settings/utils/providerUtils"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { usePlatform } from "@/context/PlatformContext"
import { useNormalizedApiConfiguration } from "@/hooks/useNormalizedApiConfiguration"
import { refreshScripts, usableScripts, useScripts } from "@/hooks/useScripts"
import { cn } from "@/lib/utils"
import { FileServiceClient, StateServiceClient } from "@/services/grpc-client"
import {
	ContextMenuOptionType,
	getContextMenuOptionIndex,
	getContextMenuOptions,
	insertMention,
	insertMentionDirectly,
	removeMention,
	type SearchResult,
	shouldShowContextMenu,
} from "@/utils/context-mentions"
import { useMetaKeyDetection, useShortcut } from "@/utils/hooks"
import { isSafari } from "@/utils/platformUtils"
import {
	getMatchingSlashCommands,
	insertSlashCommand,
	MODE_SWITCHED_BY_COMMAND_EVENT,
	removeSlashCommand,
	shouldShowSlashCommandsMenu,
	slashCommandDeleteRegex,
	slashCommandRegexGlobal,
	validateSlashCommand,
} from "@/utils/slash-commands"
import { useResolvedComposerTaskGroup } from "../taskGroup/composerTaskGroup"
import DetectedTicketChips from "../taskGroup/DetectedTicketChips"
import { getModeToggleDraftAction } from "./chat-textarea-mode-toggle"
import { type EnterSendsAs, resolveSubmitKey, type SendKind } from "./chat-view/utils/composerKeys"
import type { PromptStashEntry } from "./chat-view/utils/promptStash"
import { buildThreadPath } from "./chat-view/utils/threadUtils"
import ApprovalsMenu from "./composer/ApprovalsMenu"
import { McpServersButton, RulesButton } from "./composer/ComposerPanelButtons"
import ConfigPicker from "./composer/ConfigPicker"
import { type ComposerRowLayout, useComposerRowLayout } from "./composer/composerRowLayout"
import { modelHasReasoning } from "./composer/modelSelection"
import PlusMenu from "./composer/PlusMenu"
import ReasoningEffortPicker from "./composer/ReasoningEffortPicker"
import { ShrinkSlot } from "./composer/ShrinkSlot"
import WherePill, { ComposerTaskGroupSheet, useWherePillHasTask } from "./composer/WherePill"
import { WorkspaceButton } from "./composer/worktreeSlot"
import NoteMentionMenu from "./NoteMentionMenu"
import {
	findNoteMention,
	groupNotesToOptions,
	insertNoteMention,
	matchNotes,
	type NoteMentionOption,
	useAllNotes,
} from "./noteMentions"
import PromptStashButton from "./PromptStashButton"
import ThreadMentionMenu from "./ThreadMentionMenu"
import { findThreadMention, insertThreadMention, type ThreadMentionOption, useThreadMentionMatches } from "./threadMentions"

const { MAX_IMAGES_AND_FILES_PER_MESSAGE } = CHAT_CONSTANTS

const getImageDimensions = (dataUrl: string): Promise<{ width: number; height: number }> => {
	return new Promise((resolve, reject) => {
		const img = new Image()
		img.onload = () => {
			if (img.naturalWidth > 7500 || img.naturalHeight > 7500) {
				reject(new Error("Image dimensions exceed maximum allowed size of 7500px."))
			} else {
				resolve({ width: img.naturalWidth, height: img.naturalHeight })
			}
		}
		img.onerror = (err) => {
			console.error("Failed to load image for dimension check:", err)
			reject(new Error("Failed to load image to check dimensions."))
		}
		img.src = dataUrl
	})
}

// Set to "File" option by default
const DEFAULT_CONTEXT_MENU_OPTION = getContextMenuOptionIndex(ContextMenuOptionType.File)

export interface ChatTextAreaProps {
	inputValue: string
	/** Whether quotes are attached above the composer; counts as draft content for Esc-to-stash. */
	hasQuotes?: boolean
	/** Quote chips shown in one row at the top of the input box. */
	quoteTags?: React.ReactNode
	setInputValue: (value: string) => void
	/** The user picked this thread from the `thread:` mention menu (its token was just inserted). */
	onThreadPicked?: (threadId: string) => void
	/** The script run the draft holds after a user edit: set when it starts with a runnable `/script options`. */
	onScriptRun?: (scriptRun: { name: string; values: ScriptValues } | undefined) => void
	sendingDisabled: boolean
	placeholderText: string
	selectedFiles: string[]
	selectedImages: string[]
	setSelectedImages: React.Dispatch<React.SetStateAction<string[]>>
	setSelectedFiles: React.Dispatch<React.SetStateAction<string[]>>
	onSend: () => void
	onSelectFilesAndImages: () => void
	shouldDisableFilesAndImages: boolean
	onHeightChange?: (height: number) => void
	onFocusChange?: (isFocused: boolean) => void
	stashEntries?: PromptStashEntry[]
	/** Stashes and clears the current draft. Returns false when there was nothing to stash. */
	onStash?: () => boolean
	onRestoreStash?: (id: string) => void
	onDeleteStash?: (id: string) => void
	/** The focused task is mid-turn: submits become steer / interject. */
	isRunning?: boolean
	/** No task is open (home composer): Ctrl/Cmd+Enter starts the chat in the background. */
	isHome?: boolean
	/** What Enter does while running; Ctrl/Cmd+Enter does the other. */
	enterSendsAs?: EnterSendsAs
	/** Sends as interject / aside / background. Steer and normal sends go through `onSend`. */
	onSendAs?: (kind: Exclude<SendKind, "send" | "steer">) => void
	/**
	 * Context usage + cost meter at the right of the bottom row, before the Ask/Act toggle. The row
	 * collapses its optional parts (`hasCost`, `hasCompactNudge`) when narrow; `render` gets the result.
	 */
	usageIndicator?: {
		hasCost: boolean
		hasCompactNudge: boolean
		render: (layout: ComposerRowLayout) => React.ReactNode
	}
	/** Opens a task group's page (the task pill's "Open task"). */
	onOpenTaskGroup?: (taskGroupId: string) => void
	/** A vscode:// message link was pasted — becomes a message tag (context, not a quote) instead of raw text. */
	onPasteMessageLink?: (link: ParsedMessageLink, rawUrl: string) => void
}

interface GitCommit {
	type: ContextMenuOptionType.Git
	value: string
	label: string
	description: string
}

const QUOTE_ROW_HEIGHT = 24

const PLAN_MODE_COLOR = "var(--vscode-activityWarningBadge-background)"
const ACT_MODE_COLOR = "var(--vscode-focusBorder)"

const modeSwitchFlash = keyframes`
	0% {
		box-shadow: 0 0 0 0 var(--vscode-focusBorder);
	}
	100% {
		box-shadow: 0 0 0 7px transparent;
	}
`

const SwitchContainer = styled.div.withConfig({
	shouldForwardProp: (prop) => prop !== "$flash",
})<{ disabled: boolean; $flash?: boolean }>`
	display: flex;
	align-items: center;
	background-color: transparent;
	border: 1px solid var(--vscode-input-border);
	border-radius: 12px;
	overflow: hidden;
	cursor: ${(props) => (props.disabled ? "not-allowed" : "pointer")};
	opacity: ${(props) => (props.disabled ? 0.5 : 1)};
	transform: scale(1);
	transform-origin: right center;
	margin-left: 0;
	user-select: none; // Prevent text selection
	animation: ${(props) => (props.$flash ? css`${modeSwitchFlash} 0.7s ease-out` : "none")};

	@media (prefers-reduced-motion: reduce) {
		animation: none;
	}
	/* VS Code's workbench.reduceMotion lands as a body class, not a media query. */
	body.vscode-reduce-motion & {
		animation: none;
	}
`

const Slider = styled.div.withConfig({
	shouldForwardProp: (prop) => !["isAct", "isPlan"].includes(prop),
})<{ isAct: boolean; isPlan?: boolean }>`
	position: absolute;
	height: 100%;
	width: 50%;
	background-color: ${(props) => (props.isPlan ? PLAN_MODE_COLOR : ACT_MODE_COLOR)};
	transition:
		transform 0.22s cubic-bezier(0.3, 0.7, 0.2, 1),
		background-color 0.22s ease;
	transform: translateX(${(props) => (props.isAct ? "100%" : "0%")});

	@media (prefers-reduced-motion: reduce) {
		transition: none;
	}
	/* VS Code's workbench.reduceMotion lands as a body class, not a media query. */
	body.vscode-reduce-motion & {
		transition: none;
	}
`

const ButtonGroup = styled.div`
	display: flex;
	align-items: center;
	gap: 4px;
	flex: 1;
	min-width: 0;
	/* Clips (never overlaps) the meter and toggle if the collapse breakpoints undershoot. */
	overflow-x: clip;
	/* The icon buttons and the shield keep their size; the where pill and the configuration and effort pickers truncate to their min-width. */
	& > * {
		flex-shrink: 0;
	}
	& > [data-shrink] {
		flex-shrink: 1;
	}
`

interface RunningSendButtonsProps {
	disabled: boolean
	enterSendsAs: EnterSendsAs
	metaKeyChar: string
	onSteer: () => void
	onInterject: () => void
}

/** While the agent runs, send splits into steer (queue after this turn) and interject (stop and send now). */
const RunningSendButtons = ({ disabled, enterSendsAs, metaKeyChar, onSteer, onInterject }: RunningSendButtonsProps) => {
	const keyFor = (kind: EnterSendsAs) => (kind === enterSendsAs ? "Enter" : `${metaKeyChar}+Enter`)
	const buttons = [
		{
			kind: "steer" as const,
			label: "Steer",
			tooltip: `Steer (${keyFor("steer")}): queue this message for after the current turn`,
			icon: <SendHorizontalIcon size={13} />,
			onClick: onSteer,
		},
		{
			kind: "interject" as const,
			label: "Interject",
			tooltip: `Interject (${keyFor("interject")}): stop the current turn and send now`,
			icon: <ZapIcon size={13} />,
			onClick: onInterject,
		},
	]
	return (
		<div className="flex items-center gap-0.5">
			{buttons.map((button) => (
				<button
					aria-label={button.label}
					className={cn(
						"flex size-5 items-center justify-center rounded-xs border-0 bg-transparent p-0 cursor-pointer hover:bg-toolbar-hover disabled:cursor-not-allowed disabled:opacity-50",
						button.kind === enterSendsAs ? "text-link" : "text-description hover:text-foreground",
					)}
					data-testid={`${button.kind}-button`}
					disabled={disabled}
					key={button.kind}
					onClick={button.onClick}
					title={button.tooltip}
					type="button">
					{button.icon}
				</button>
			))}
		</div>
	)
}

const ChatTextArea = forwardRef<HTMLTextAreaElement, ChatTextAreaProps>(
	(
		{
			inputValue,
			setInputValue: setDraftInputValue,
			onThreadPicked,
			onScriptRun,
			sendingDisabled,
			placeholderText,
			selectedFiles,
			selectedImages,
			setSelectedImages,
			setSelectedFiles,
			onSend,
			onSelectFilesAndImages,
			shouldDisableFilesAndImages,
			onHeightChange,
			onFocusChange,
			hasQuotes = false,
			quoteTags,
			stashEntries = [],
			onStash,
			onRestoreStash,
			onDeleteStash,
			isRunning = false,
			isHome = false,
			enterSendsAs = "steer",
			onSendAs,
			usageIndicator,
			onOpenTaskGroup,
			onPasteMessageLink,
		},
		ref,
	) => {
		const {
			mode,
			apiConfiguration,
			openRouterModels,
			platform,
			localWorkflowToggles,
			globalWorkflowToggles,
			remoteWorkflowToggles,
			remoteConfigSettings,
			navigateToSettingsModelPicker,
			mcpServers,
			currentTaskItem,
			taskHistory,
			taskGroups,
		} = useExtensionState()
		const [isTextAreaFocused, setIsTextAreaFocused] = useState(false)
		const [isDraggingOver, setIsDraggingOver] = useState(false)
		const [gitCommits, setGitCommits] = useState<GitCommit[]>([])
		const [showSlashCommandsMenu, setShowSlashCommandsMenu] = useState(false)
		const [selectedSlashCommandsIndex, setSelectedSlashCommandsIndex] = useState(0)
		const [slashCommandsQuery, setSlashCommandsQuery] = useState("")
		const slashCommandsMenuContainerRef = useRef<HTMLDivElement>(null)

		const [thumbnailsHeight, setThumbnailsHeight] = useState(0)
		// Space reserved above the text for the quote chip row.
		const quoteRowHeight = quoteTags ? QUOTE_ROW_HEIGHT : 0
		const [textAreaBaseHeight, setTextAreaBaseHeight] = useState<number | undefined>(undefined)
		const [showContextMenu, setShowContextMenu] = useState(false)
		const [cursorPosition, setCursorPosition] = useState(0)
		const [searchQuery, setSearchQuery] = useState("")
		const textAreaRef = useRef<HTMLTextAreaElement | null>(null)
		// Saved scripts: offered by the slash menu and the rules panel's Scripts tab. A draft starting with `/script-name `
		// shows the options helper above the input and cannot be sent until its required options are set.
		const scriptsSnapshot = useScripts()
		const usable = useMemo(() => usableScripts(scriptsSnapshot), [scriptsSnapshot])
		const scriptCommands = useMemo<SlashCommand[]>(
			() => usable.map((script) => ({ name: script.name, description: script.description, section: "script" as const })),
			[usable],
		)
		const scriptInput = useMemo(() => matchScriptInput(inputValue, usable), [inputValue, usable])
		// Every edit made through this composer (typing, menu picks, the helper strip) is the user's own,
		// so a draft that now starts with a runnable script is a script run the user asked for. Text
		// that arrives another way (Add to Cline, restored drafts) never reaches here.
		const setInputValue = useCallback(
			(value: string) => {
				setDraftInputValue(value)
				onScriptRun?.(scriptRunOf(value, usable))
			},
			[setDraftInputValue, onScriptRun, usable],
		)
		const sendDisabled = sendingDisabled || !isScriptInputSendable(scriptInput)
		// A script runs only when the message starts with it, so `/` mid-message doesn't offer scripts.
		const slashAtMessageStart = useMemo(() => {
			const beforeCursor = inputValue.slice(0, cursorPosition)
			const slashIndex = beforeCursor.lastIndexOf("/")
			return slashIndex >= 0 && beforeCursor.slice(0, slashIndex).trim() === ""
		}, [inputValue, cursorPosition])
		const menuScriptCommands = slashAtMessageStart ? scriptCommands : []
		// Re-read the script folders whenever the slash menu opens, so a script just saved shows up.
		useEffect(() => {
			if (showSlashCommandsMenu) void refreshScripts()
		}, [showSlashCommandsMenu])
		/** Starts a script draft from the rules panel's Scripts tab; whatever was typed becomes the note under the options line. */
		const startScriptDraft = useCallback(
			(name: string) => {
				const prefix = `/${name} `
				const existing = textAreaRef.current?.value ?? inputValue
				setInputValue(existing.trim() ? `${prefix}\n${existing}` : prefix)
				setCursorPosition(prefix.length)
				setIntendedCursorPosition(prefix.length)
				setTimeout(() => textAreaRef.current?.focus(), 0)
			},
			[inputValue, setInputValue],
		)
		const [isMouseDownOnMenu, setIsMouseDownOnMenu] = useState(false)
		const highlightLayerRef = useRef<HTMLDivElement>(null)
		const [selectedMenuIndex, setSelectedMenuIndex] = useState(-1)
		const [selectedType, setSelectedType] = useState<ContextMenuOptionType | null>(null)
		const [justDeletedSpaceAfterMention, setJustDeletedSpaceAfterMention] = useState(false)
		const [justDeletedSpaceAfterSlashCommand, setJustDeletedSpaceAfterSlashCommand] = useState(false)
		const [intendedCursorPosition, setIntendedCursorPosition] = useState<number | null>(null)
		const contextMenuContainerRef = useRef<HTMLDivElement>(null)
		const bottomRowRef = useRef<HTMLDivElement>(null)

		const [shownTooltipMode, setShownTooltipMode] = useState<Mode | null>(null)

		// `#note` mentions search every task's notes; the task this composer's
		// thread (or task page) belongs to ranks first and inserts bare `#slug`.
		// Picks from other tasks insert `#<group>/<slug>` so the host can resolve
		// them against that task's notebook.
		const composerTaskGroupId = useResolvedComposerTaskGroup()
		const noteTaskGroupId = currentTaskItem
			? buildThreadPath(currentTaskItem, taskHistory ?? []).taskGroupId
			: composerTaskGroupId
		const noteMention = useMemo(() => findNoteMention(inputValue, cursorPosition), [inputValue, cursorPosition])
		const [dismissedNoteMentionAt, setDismissedNoteMentionAt] = useState<number>()
		const [selectedNoteIndex, setSelectedNoteIndex] = useState(0)
		const noteGroups = useAllNotes(noteMention ? taskGroups : undefined)
		const taskNotes = useMemo(() => groupNotesToOptions(noteGroups, noteTaskGroupId), [noteGroups, noteTaskGroupId])
		const noteMatches = useMemo(() => (noteMention ? matchNotes(taskNotes, noteMention.query) : []), [taskNotes, noteMention])
		const showNoteMentionMenu =
			!!noteMention &&
			noteMention.start !== dismissedNoteMentionAt &&
			noteMatches.length > 0 &&
			isTextAreaFocused &&
			!showSlashCommandsMenu &&
			!showContextMenu
		useEffect(() => {
			if (!noteMention) setDismissedNoteMentionAt(undefined)
			setSelectedNoteIndex(0)
		}, [noteMention?.start, noteMention?.query])

		const handleNoteMentionSelect = useCallback(
			(note: NoteMentionOption) => {
				if (!noteMention) return
				const next = insertNoteMention(inputValue, cursorPosition, noteMention.start, note.insertText ?? `#${note.slug}`)
				setInputValue(next.value)
				setCursorPosition(next.cursor)
				setIntendedCursorPosition(next.cursor)
			},
			[noteMention, inputValue, cursorPosition, setInputValue],
		)

		// `thread:` mentions pick any thread from any task; the mention sends the
		// agent the thread's title + id and unlocks its transcript tools for this
		// conversation.
		const threadMention = useMemo(() => findThreadMention(inputValue, cursorPosition), [inputValue, cursorPosition])
		const [dismissedThreadMentionAt, setDismissedThreadMentionAt] = useState<number>()
		const [selectedThreadIndex, setSelectedThreadIndex] = useState(0)
		const taskGroupTitleById = useMemo(
			() => new Map((taskGroups ?? []).map((group) => [group.id, group.title])),
			[taskGroups],
		)
		const activeThreadMention = threadMention && threadMention.start !== dismissedThreadMentionAt ? threadMention : undefined
		const threadMatches = useThreadMentionMatches(
			taskHistory,
			taskGroupTitleById,
			currentTaskItem?.id,
			activeThreadMention?.query ?? null,
		)
		const showThreadMentionMenu =
			!!activeThreadMention &&
			threadMatches.length > 0 &&
			isTextAreaFocused &&
			!showSlashCommandsMenu &&
			!showContextMenu &&
			!showNoteMentionMenu
		useEffect(() => {
			if (!threadMention) setDismissedThreadMentionAt(undefined)
			setSelectedThreadIndex(0)
		}, [threadMention?.start, threadMention?.query])

		const handleThreadMentionSelect = useCallback(
			(thread: ThreadMentionOption) => {
				if (!threadMention) return
				const next = insertThreadMention(inputValue, cursorPosition, threadMention.start, thread.id)
				setInputValue(next.value)
				onThreadPicked?.(thread.id)
				setCursorPosition(next.cursor)
				setIntendedCursorPosition(next.cursor)
			},
			[threadMention, inputValue, cursorPosition, setInputValue, onThreadPicked],
		)
		const [modeSwitchFlash, setModeSwitchFlash] = useState(false)
		const [pendingInsertions, setPendingInsertions] = useState<string[]>([])
		const _shiftHoldTimerRef = useRef<NodeJS.Timeout | null>(null)
		const [showUnsupportedFileError, setShowUnsupportedFileError] = useState(false)
		const unsupportedFileTimerRef = useRef<NodeJS.Timeout | null>(null)
		const [showDimensionError, setShowDimensionError] = useState(false)
		const dimensionErrorTimerRef = useRef<NodeJS.Timeout | null>(null)

		const [fileSearchResults, setFileSearchResults] = useState<SearchResult[]>([])
		const [searchLoading, setSearchLoading] = useState(false)
		const [, metaKeyChar] = useMetaKeyDetection(platform)
		const { selectedProvider, selectedModelId, selectedModelInfo } = useNormalizedApiConfiguration(mode, true)
		// Images are attached regardless; when the selected model has no image input the thumbnails get a warning
		// badge and a notice offers to switch models. Unknown capability data fails open, like core does.
		const modelSupportsImages = selectedModelInfo.supportsImages !== false
		// Leave room for the stash icon next to send while the stash has entries.
		const showRunningSendButtons = isRunning && !!onSendAs
		const showHomeBackgroundButton = isHome && !isRunning && !!onSendAs
		const inputPaddingRight =
			(stashEntries.length > 0 ? 48 : 28) + (showRunningSendButtons ? 22 : 0) + (showHomeBackgroundButton ? 22 : 0)
		const unsupportedImagesAttached = selectedImages.length > 0 && !modelSupportsImages

		// Fetch git commits when Git is selected or when typing a hash
		useEffect(() => {
			if (selectedType === ContextMenuOptionType.Git || /^[a-f0-9]+$/i.test(searchQuery)) {
				FileServiceClient.searchCommits(StringRequest.create({ value: searchQuery || "" }))
					.then((response) => {
						if (response.commits) {
							const commits: GitCommit[] = response.commits.map(
								(commit: { hash: string; shortHash: string; subject: string; author: string; date: string }) => ({
									type: ContextMenuOptionType.Git,
									value: commit.hash,
									label: commit.subject,
									description: `${commit.shortHash} by ${commit.author} on ${commit.date}`,
								}),
							)
							setGitCommits(commits)
						}
					})
					.catch((error) => {
						console.error("Error searching commits:", error)
					})
			}
		}, [selectedType, searchQuery])

		const queryItems = useMemo(() => {
			return [
				{ type: ContextMenuOptionType.Problems, value: "problems" },
				{ type: ContextMenuOptionType.Terminal, value: "terminal" },
				...gitCommits,
			]
		}, [gitCommits])

		useEffect(() => {
			const handleClickOutside = (event: MouseEvent) => {
				if (contextMenuContainerRef.current && !contextMenuContainerRef.current.contains(event.target as Node)) {
					setShowContextMenu(false)
				}
			}

			if (showContextMenu) {
				document.addEventListener("mousedown", handleClickOutside)
			}

			return () => {
				document.removeEventListener("mousedown", handleClickOutside)
			}
		}, [showContextMenu, setShowContextMenu])

		useEffect(() => {
			const handleClickOutsideSlashMenu = (event: MouseEvent) => {
				if (
					slashCommandsMenuContainerRef.current &&
					!slashCommandsMenuContainerRef.current.contains(event.target as Node)
				) {
					setShowSlashCommandsMenu(false)
				}
			}

			if (showSlashCommandsMenu) {
				document.addEventListener("mousedown", handleClickOutsideSlashMenu)
			}

			return () => {
				document.removeEventListener("mousedown", handleClickOutsideSlashMenu)
			}
		}, [showSlashCommandsMenu])

		const handleMentionSelect = useCallback(
			(type: ContextMenuOptionType, value?: string) => {
				if (type === ContextMenuOptionType.NoResults) {
					return
				}

				if (
					type === ContextMenuOptionType.File ||
					type === ContextMenuOptionType.Folder ||
					type === ContextMenuOptionType.Git
				) {
					if (!value) {
						setSelectedType(type)
						setSearchQuery("")
						setSelectedMenuIndex(0)

						// Trigger search with the selected type
						if (type === ContextMenuOptionType.File || type === ContextMenuOptionType.Folder) {
							setSearchLoading(true)

							// Map ContextMenuOptionType to FileSearchType enum
							let searchType: FileSearchType | undefined
							if (type === ContextMenuOptionType.File) {
								searchType = FileSearchType.FILE
							} else if (type === ContextMenuOptionType.Folder) {
								searchType = FileSearchType.FOLDER
							}

							const myToken = ++latestSearchTokenRef.current
							FileServiceClient.searchFiles(
								FileSearchRequest.create({
									query: "",
									mentionsRequestId: String(myToken),
									selectedType: searchType,
								}),
							)
								.then((results) => {
									if (myToken !== latestSearchTokenRef.current) {
										// Stale response — a newer search has been issued.
										return
									}
									setFileSearchResults((results.results || []) as SearchResult[])
									setSearchLoading(false)
								})
								.catch((error) => {
									if (myToken !== latestSearchTokenRef.current) {
										return
									}
									console.error("Error searching files:", error)
									setFileSearchResults([])
									setSearchLoading(false)
								})
						}
						return
					}
				}

				setShowContextMenu(false)
				setSelectedType(null)
				const queryLength = searchQuery.length
				setSearchQuery("")

				if (textAreaRef.current) {
					let insertValue = value || ""
					if (type === ContextMenuOptionType.URL) {
						insertValue = value || ""
					} else if (type === ContextMenuOptionType.File || type === ContextMenuOptionType.Folder) {
						insertValue = value || ""
					} else if (type === ContextMenuOptionType.Problems) {
						insertValue = "problems"
					} else if (type === ContextMenuOptionType.Terminal) {
						insertValue = "terminal"
					} else if (type === ContextMenuOptionType.Git) {
						insertValue = value || ""
					}

					const { newValue, mentionIndex } = insertMention(
						textAreaRef.current.value,
						cursorPosition,
						insertValue,
						queryLength,
					)

					setInputValue(newValue)
					const newCursorPosition = newValue.indexOf(" ", mentionIndex + insertValue.length) + 1
					setCursorPosition(newCursorPosition)
					setIntendedCursorPosition(newCursorPosition)
					// textAreaRef.current.focus()

					// scroll to cursor
					setTimeout(() => {
						if (textAreaRef.current) {
							textAreaRef.current.blur()
							textAreaRef.current.focus()
						}
					}, 0)
				}
			},
			[setInputValue, cursorPosition, searchQuery],
		)

		const handleSlashCommandsSelect = useCallback(
			(command: SlashCommand) => {
				setShowSlashCommandsMenu(false)
				const queryLength = slashCommandsQuery.length
				setSlashCommandsQuery("")

				if (textAreaRef.current) {
					const { newValue, commandIndex } = insertSlashCommand(
						textAreaRef.current.value,
						command.name,
						queryLength,
						cursorPosition,
					)
					const newCursorPosition = newValue.indexOf(" ", commandIndex + 1 + command.name.length) + 1

					setInputValue(newValue)
					setCursorPosition(newCursorPosition)
					setIntendedCursorPosition(newCursorPosition)

					setTimeout(() => {
						if (textAreaRef.current) {
							textAreaRef.current.blur()
							textAreaRef.current.focus()
						}
					}, 0)
				}
			},
			[setInputValue, slashCommandsQuery, cursorPosition],
		)
		const handleKeyDown = useCallback(
			(event: React.KeyboardEvent<HTMLTextAreaElement>) => {
				const isSelectAllShortcut =
					(event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "a"
				if (isSelectAllShortcut) {
					event.preventDefault()
					event.stopPropagation()
					const textArea = event.currentTarget
					textArea.setSelectionRange(0, textArea.value.length)
					setCursorPosition(0)
					return
				}

				// Safari does not support InputEvent.isComposing (always false), so we need to fallback to keyCode === 229 for it
				const isComposing = isSafari ? event.nativeEvent.keyCode === 229 : (event.nativeEvent?.isComposing ?? false)

				if (showNoteMentionMenu && noteMention && !isComposing) {
					if (event.key === "Escape") {
						event.preventDefault()
						setDismissedNoteMentionAt(noteMention.start)
						return
					}
					if (event.key === "ArrowUp" || event.key === "ArrowDown") {
						event.preventDefault()
						const direction = event.key === "ArrowUp" ? -1 : 1
						setSelectedNoteIndex((index) => (index + direction + noteMatches.length) % noteMatches.length)
						return
					}
					const plain = !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey
					if ((event.key === "Enter" || event.key === "Tab") && plain) {
						event.preventDefault()
						handleNoteMentionSelect(noteMatches[Math.min(selectedNoteIndex, noteMatches.length - 1)])
						return
					}
				}

				if (showThreadMentionMenu && activeThreadMention && !isComposing) {
					if (event.key === "Escape") {
						event.preventDefault()
						setDismissedThreadMentionAt(activeThreadMention.start)
						return
					}
					if (event.key === "ArrowUp" || event.key === "ArrowDown") {
						event.preventDefault()
						const direction = event.key === "ArrowUp" ? -1 : 1
						setSelectedThreadIndex((index) => (index + direction + threadMatches.length) % threadMatches.length)
						return
					}
					const plain = !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey
					if ((event.key === "Enter" || event.key === "Tab") && plain) {
						event.preventDefault()
						handleThreadMentionSelect(threadMatches[Math.min(selectedThreadIndex, threadMatches.length - 1)])
						return
					}
				}

				if (showSlashCommandsMenu) {
					if (event.key === "Escape") {
						setShowSlashCommandsMenu(false)
						setSlashCommandsQuery("")
						return
					}

					if (event.key === "ArrowUp" || event.key === "ArrowDown") {
						event.preventDefault()
						setSelectedSlashCommandsIndex((prevIndex) => {
							const direction = event.key === "ArrowUp" ? -1 : 1
							// Get commands with workflow toggles
							const allCommands = getMatchingSlashCommands(
								slashCommandsQuery,
								localWorkflowToggles,
								globalWorkflowToggles,
								remoteWorkflowToggles,
								remoteConfigSettings?.remoteGlobalWorkflows,
								mcpServers,
								menuScriptCommands,
							)

							if (allCommands.length === 0) {
								return prevIndex
							}

							// Calculate total command count
							const totalCommandCount = allCommands.length

							// Create wraparound navigation - moves from last item to first and vice versa
							const newIndex = (prevIndex + direction + totalCommandCount) % totalCommandCount
							return newIndex
						})
						return
					}

					if ((event.key === "Enter" || event.key === "Tab") && selectedSlashCommandsIndex !== -1) {
						event.preventDefault()
						const commands = getMatchingSlashCommands(
							slashCommandsQuery,
							localWorkflowToggles,
							globalWorkflowToggles,
							remoteWorkflowToggles,
							remoteConfigSettings?.remoteGlobalWorkflows,
							mcpServers,
							menuScriptCommands,
						)
						if (commands.length > 0) {
							handleSlashCommandsSelect(commands[selectedSlashCommandsIndex])
						}
						return
					}
				}
				if (showContextMenu) {
					if (event.key === "Escape") {
						setShowContextMenu(false)
						setSelectedType(null)
						setSelectedMenuIndex(DEFAULT_CONTEXT_MENU_OPTION)
						setSearchQuery("")
						return
					}

					if (event.key === "ArrowUp" || event.key === "ArrowDown") {
						event.preventDefault()
						setSelectedMenuIndex((prevIndex) => {
							const direction = event.key === "ArrowUp" ? -1 : 1
							const options = getContextMenuOptions(searchQuery, selectedType, queryItems, fileSearchResults)
							const optionsLength = options.length

							if (optionsLength === 0) {
								return prevIndex
							}

							// Find selectable options (non-URL types)
							const selectableOptions = options.filter(
								(option) =>
									option.type !== ContextMenuOptionType.URL && option.type !== ContextMenuOptionType.NoResults,
							)

							if (selectableOptions.length === 0) {
								return -1 // No selectable options
							}

							// Find the index of the next selectable option
							const currentSelectableIndex = selectableOptions.indexOf(options[prevIndex])

							const newSelectableIndex =
								(currentSelectableIndex + direction + selectableOptions.length) % selectableOptions.length

							// Find the index of the selected option in the original options array
							return options.indexOf(selectableOptions[newSelectableIndex])
						})
						return
					}
					if ((event.key === "Enter" || event.key === "Tab") && selectedMenuIndex !== -1) {
						event.preventDefault()
						const selectedOption = getContextMenuOptions(searchQuery, selectedType, queryItems, fileSearchResults)[
							selectedMenuIndex
						]
						if (
							selectedOption &&
							selectedOption.type !== ContextMenuOptionType.URL &&
							selectedOption.type !== ContextMenuOptionType.NoResults
						) {
							// Use label if it contains workspace prefix, otherwise use value
							const mentionValue = selectedOption.label?.includes(":") ? selectedOption.label : selectedOption.value
							handleMentionSelect(selectedOption.type, mentionValue)
						}
						return
					}
				}

				// Tab in a script draft completes the option being typed, then jumps to the next missing required one.
				if (
					event.key === "Tab" &&
					scriptInput &&
					!isComposing &&
					!event.shiftKey &&
					!event.metaKey &&
					!event.ctrlKey &&
					!event.altKey &&
					// Anywhere on the options line; Tab in the note below keeps its normal behaviour.
					(event.currentTarget.selectionStart ?? 0) <= scriptInput.prefix.length + scriptInput.optionsText.length
				) {
					event.preventDefault()
					const completed = completeScriptInput(scriptInput)
					if (completed) {
						setInputValue(completed.text)
						setCursorPosition(completed.cursor)
						setIntendedCursorPosition(completed.cursor)
					}
					return
				}

				// Esc with an open menu closes it (handled above); otherwise it stashes a non-empty draft.
				if (event.key === "Escape" && !isComposing && onStash && (inputValue.trim() || hasQuotes)) {
					if (onStash()) {
						event.preventDefault()
						setCursorPosition(0)
					}
					return
				}

				const submitKind = isComposing
					? null
					: resolveSubmitKey(event, { running: isRunning, enterSendsAs, onHome: isHome })
				if (submitKind) {
					event.preventDefault()

					if (!sendDisabled) {
						// Note: don't set isTextAreaFocused to false here. The textarea keeps
						// DOM focus after sending, and clearing the flag without an actual
						// blur desyncs it permanently (programmatic .focus() on an
						// already-focused element never re-fires onFocus), which hides the
						// plan/act mode outline until a real blur/refocus cycle.
						if (submitKind === "send" || submitKind === "steer" || !onSendAs) {
							onSend()
						} else {
							onSendAs(submitKind)
						}
					}
				}

				if (event.key === "Backspace" && !isComposing) {
					const charBeforeCursor = inputValue[cursorPosition - 1]
					const charAfterCursor = inputValue[cursorPosition + 1]

					const charBeforeIsWhitespace =
						charBeforeCursor === " " || charBeforeCursor === "\n" || charBeforeCursor === "\r\n"
					const charAfterIsWhitespace =
						charAfterCursor === " " || charAfterCursor === "\n" || charAfterCursor === "\r\n"

					// Check if we're right after a space that follows a mention or slash command
					if (
						charBeforeIsWhitespace &&
						inputValue.slice(0, cursorPosition - 1).match(new RegExp(mentionRegex.source + "$"))
					) {
						// File mention handling
						const newCursorPosition = cursorPosition - 1
						if (!charAfterIsWhitespace) {
							event.preventDefault()
							textAreaRef.current?.setSelectionRange(newCursorPosition, newCursorPosition)
							setCursorPosition(newCursorPosition)
						}
						setCursorPosition(newCursorPosition)
						setJustDeletedSpaceAfterMention(true)
						setJustDeletedSpaceAfterSlashCommand(false)
					} else if (charBeforeIsWhitespace && inputValue.slice(0, cursorPosition - 1).match(slashCommandDeleteRegex)) {
						// New slash command handling
						const newCursorPosition = cursorPosition - 1
						if (!charAfterIsWhitespace) {
							event.preventDefault()
							textAreaRef.current?.setSelectionRange(newCursorPosition, newCursorPosition)
							setCursorPosition(newCursorPosition)
						}
						setCursorPosition(newCursorPosition)
						setJustDeletedSpaceAfterSlashCommand(true)
						setJustDeletedSpaceAfterMention(false)
					}
					// Handle the second backspace press for mentions or slash commands
					else if (justDeletedSpaceAfterMention) {
						const { newText, newPosition } = removeMention(inputValue, cursorPosition)
						if (newText !== inputValue) {
							event.preventDefault()
							setInputValue(newText)
							setIntendedCursorPosition(newPosition)
						}
						setJustDeletedSpaceAfterMention(false)
						setShowContextMenu(false)
					} else if (justDeletedSpaceAfterSlashCommand) {
						// New slash command deletion
						const { newText, newPosition } = removeSlashCommand(inputValue, cursorPosition)
						if (newText !== inputValue) {
							event.preventDefault()
							setInputValue(newText)
							setIntendedCursorPosition(newPosition)
						}
						setJustDeletedSpaceAfterSlashCommand(false)
						setShowSlashCommandsMenu(false)
					}
					// Default case - reset flags if none of the above apply
					else {
						setJustDeletedSpaceAfterMention(false)
						setJustDeletedSpaceAfterSlashCommand(false)
					}
				}
			},
			[
				onSend,
				showContextMenu,
				searchQuery,
				selectedMenuIndex,
				handleMentionSelect,
				selectedType,
				inputValue,
				cursorPosition,
				setInputValue,
				justDeletedSpaceAfterMention,
				queryItems,
				fileSearchResults,
				showSlashCommandsMenu,
				selectedSlashCommandsIndex,
				slashCommandsQuery,
				handleSlashCommandsSelect,
				sendDisabled,
				scriptInput,
				menuScriptCommands,
				onStash,
				hasQuotes,
				isRunning,
				isHome,
				enterSendsAs,
				onSendAs,
				showNoteMentionMenu,
				noteMention,
				noteMatches,
				selectedNoteIndex,
				handleNoteMentionSelect,
			],
		)

		// Effect to set cursor position after state updates
		useLayoutEffect(() => {
			if (intendedCursorPosition !== null && textAreaRef.current) {
				textAreaRef.current.setSelectionRange(intendedCursorPosition, intendedCursorPosition)
				setIntendedCursorPosition(null) // Reset the state after applying
			}
		}, [inputValue, intendedCursorPosition])

		useEffect(() => {
			if (pendingInsertions.length === 0 || !textAreaRef.current) {
				return
			}

			const path = pendingInsertions[0]
			const currentTextArea = textAreaRef.current
			const currentValue = currentTextArea.value
			const currentCursorPos =
				intendedCursorPosition ??
				(currentTextArea.selectionStart >= 0 ? currentTextArea.selectionStart : currentValue.length)

			const { newValue, mentionIndex } = insertMentionDirectly(currentValue, currentCursorPos, path)

			setInputValue(newValue)

			const newCursorPosition = mentionIndex + path.length + 2
			setIntendedCursorPosition(newCursorPosition)

			setPendingInsertions((prev) => prev.slice(1))
		}, [pendingInsertions, setInputValue])

		const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null)

		// Monotonic token; every searchFiles dispatch bumps it, and resolve
		// handlers drop their result when the token they captured at fire time
		// is no longer the latest. Prevents stale results from a cancelled or
		// superseded picker (e.g. "Add File" still in flight when user picks
		// "Add Folder") from clobbering fresh state.
		const latestSearchTokenRef = useRef(0)

		const handleInputChange = useCallback(
			(e: React.ChangeEvent<HTMLTextAreaElement>) => {
				const newValue = e.target.value
				const newCursorPosition = e.target.selectionStart
				setInputValue(newValue)
				setCursorPosition(newCursorPosition)
				let showMenu = shouldShowContextMenu(newValue, newCursorPosition)
				const showSlashCommandsMenu = shouldShowSlashCommandsMenu(newValue, newCursorPosition)

				// we do not allow both menus to be shown at the same time
				// the slash commands menu has precedence bc its a narrower component
				if (showSlashCommandsMenu) {
					showMenu = false
				}

				setShowSlashCommandsMenu(showSlashCommandsMenu)
				setShowContextMenu(showMenu)

				if (showSlashCommandsMenu) {
					// Find the slash nearest to cursor (before cursor position)
					const beforeCursor = newValue.slice(0, newCursorPosition)
					const slashIndex = beforeCursor.lastIndexOf("/")
					const query = newValue.slice(slashIndex + 1, newCursorPosition)
					setSlashCommandsQuery(query)
					setSelectedSlashCommandsIndex(0)
				} else {
					setSlashCommandsQuery("")
					setSelectedSlashCommandsIndex(0)
				}

				if (showMenu) {
					const lastAtIndex = newValue.lastIndexOf("@", newCursorPosition - 1)
					const query = newValue.slice(lastAtIndex + 1, newCursorPosition)
					setSearchQuery(query)

					if (query.length > 0) {
						setSelectedMenuIndex(0)

						// Clear any existing timeout
						if (searchTimeoutRef.current) {
							clearTimeout(searchTimeoutRef.current)
						}

						setSearchLoading(true)

						const searchType =
							selectedType === ContextMenuOptionType.File
								? FileSearchType.FILE
								: selectedType === ContextMenuOptionType.Folder
									? FileSearchType.FOLDER
									: undefined

						// Parse workspace hint from query (e.g., "@frontend:/filename")
						let workspaceHint: string | undefined
						let searchQuery = query
						const workspaceHintMatch = query.match(/^([\w-]+):\/(.*)$/)
						if (workspaceHintMatch) {
							workspaceHint = workspaceHintMatch[1]
							searchQuery = workspaceHintMatch[2]
						}

						// Set a timeout to debounce the search requests
						searchTimeoutRef.current = setTimeout(() => {
							const myToken = ++latestSearchTokenRef.current
							FileServiceClient.searchFiles(
								FileSearchRequest.create({
									query: searchQuery,
									mentionsRequestId: String(myToken),
									selectedType: searchType,
									workspaceHint: workspaceHint,
								}),
							)
								.then((results) => {
									if (myToken !== latestSearchTokenRef.current) {
										// Stale response — a newer search has been issued.
										return
									}
									setFileSearchResults((results.results || []) as SearchResult[])
									setSearchLoading(false)
								})
								.catch((error) => {
									if (myToken !== latestSearchTokenRef.current) {
										return
									}
									console.error("Error searching files:", error)
									setFileSearchResults([])
									setSearchLoading(false)
								})
						}, 200) // 200ms debounce
					} else {
						setSelectedMenuIndex(DEFAULT_CONTEXT_MENU_OPTION)
					}
				} else {
					setSearchQuery("")
					setSelectedMenuIndex(-1)
					setFileSearchResults([])
				}
			},
			[setInputValue, setFileSearchResults, selectedType],
		)

		useEffect(() => {
			if (!showContextMenu) {
				setSelectedType(null)
			}
		}, [showContextMenu])

		const handleBlur = useCallback(() => {
			// Only hide the context menu if the user didn't click on it
			if (!isMouseDownOnMenu) {
				setShowContextMenu(false)
				setShowSlashCommandsMenu(false)
			}
			setIsTextAreaFocused(false)
			onFocusChange?.(false) // Call prop on blur
		}, [isMouseDownOnMenu, onFocusChange])

		const showDimensionErrorMessage = useCallback(() => {
			setShowDimensionError(true)
			if (dimensionErrorTimerRef.current) {
				clearTimeout(dimensionErrorTimerRef.current)
			}
			dimensionErrorTimerRef.current = setTimeout(() => {
				setShowDimensionError(false)
				dimensionErrorTimerRef.current = null
			}, 3000)
		}, [])

		const handlePaste = useCallback(
			async (e: React.ClipboardEvent) => {
				const items = e.clipboardData.items

				const pastedText = e.clipboardData.getData("text")
				// A message deep link becomes a message tag carrying just that message.
				const messageLink = parseMessageLink(pastedText.trim())
				if (messageLink) {
					e.preventDefault()
					setShowContextMenu(false)
					onPasteMessageLink?.(messageLink, pastedText.trim())
					return
				}
				// Check if the pasted content is a URL, add space after so user can easily delete if they don't want it
				const urlRegex = /^\S+:\/\/\S+$/
				if (urlRegex.test(pastedText.trim())) {
					e.preventDefault()
					const trimmedUrl = pastedText.trim()
					const newValue = inputValue.slice(0, cursorPosition) + trimmedUrl + " " + inputValue.slice(cursorPosition)
					setInputValue(newValue)
					const newCursorPosition = cursorPosition + trimmedUrl.length + 1
					setCursorPosition(newCursorPosition)
					setIntendedCursorPosition(newCursorPosition)
					setShowContextMenu(false)

					// Scroll to new cursor position
					// https://stackoverflow.com/questions/29899364/how-do-you-scroll-to-the-position-of-the-cursor-in-a-textarea/40951875#40951875
					setTimeout(() => {
						if (textAreaRef.current) {
							textAreaRef.current.blur()
							textAreaRef.current.focus()
						}
					}, 0)
					// NOTE: callbacks dont utilize return function to cleanup, but it's fine since this timeout immediately executes and will be cleaned up by the browser (no chance component unmounts before it executes)

					return
				}

				const acceptedTypes = ["png", "jpeg", "webp"] // supported by anthropic and openrouter (jpg is just a file extension but the image will be recognized as jpeg)
				const imageItems = Array.from(items).filter((item) => {
					const [type, subtype] = item.type.split("/")
					return type === "image" && acceptedTypes.includes(subtype)
				})
				if (!shouldDisableFilesAndImages && imageItems.length > 0) {
					e.preventDefault()
					const imagePromises = imageItems.map((item) => {
						return new Promise<string | null>((resolve) => {
							const blob = item.getAsFile()
							if (!blob) {
								resolve(null)
								return
							}
							const reader = new FileReader()
							reader.onloadend = async () => {
								if (reader.error) {
									console.error("Error reading file:", reader.error)
									resolve(null)
								} else {
									const result = reader.result
									if (typeof result === "string") {
										try {
											await getImageDimensions(result)
											resolve(result)
										} catch (error) {
											console.warn((error as Error).message)
											showDimensionErrorMessage()
											resolve(null)
										}
									} else {
										resolve(null)
									}
								}
							}
							reader.readAsDataURL(blob)
						})
					})
					const imageDataArray = await Promise.all(imagePromises)
					const dataUrls = imageDataArray.filter((dataUrl): dataUrl is string => dataUrl !== null)
					//.map((dataUrl) => dataUrl.split(",")[1]) // strip the mime type prefix, sharp doesn't need it
					if (dataUrls.length > 0) {
						const filesAndImagesLength = selectedImages.length + selectedFiles.length
						const availableSlots = MAX_IMAGES_AND_FILES_PER_MESSAGE - filesAndImagesLength

						if (availableSlots > 0) {
							const imagesToAdd = Math.min(dataUrls.length, availableSlots)
							setSelectedImages((prevImages) => [...prevImages, ...dataUrls.slice(0, imagesToAdd)])
						}
					} else {
						console.warn("No valid images were processed")
					}
				}
			},
			[
				shouldDisableFilesAndImages,
				setSelectedImages,
				selectedImages,
				selectedFiles,
				cursorPosition,
				setInputValue,
				inputValue,
				showDimensionErrorMessage,
				onPasteMessageLink,
			],
		)

		const handleThumbnailsHeightChange = useCallback((height: number) => {
			setThumbnailsHeight(height)
		}, [])

		useEffect(() => {
			if (selectedImages.length === 0 && selectedFiles.length === 0) {
				setThumbnailsHeight(0)
			}
		}, [selectedImages, selectedFiles])

		const handleMenuMouseDown = useCallback(() => {
			setIsMouseDownOnMenu(true)
		}, [])

		const updateHighlights = useCallback(() => {
			if (!textAreaRef.current || !highlightLayerRef.current) {
				return
			}

			let processedText = textAreaRef.current.value

			processedText = processedText
				.replace(/\n$/, "\n\n")
				.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c] || c)
				// highlight @mentions
				.replace(mentionRegexGlobal, '<mark class="mention-context-textarea-highlight">$&</mark>')

			// Highlight every valid /slash-command in the text — each one is
			// expanded when the message is sent, and /ask /act switch the mode.
			slashCommandRegexGlobal.lastIndex = 0
			processedText = processedText.replace(slashCommandRegexGlobal, (match, prefix, command) => {
				// Extract just the command name (without the slash)
				const commandName = command.substring(1)
				const isValidCommand = validateSlashCommand(
					commandName,
					localWorkflowToggles,
					globalWorkflowToggles,
					remoteWorkflowToggles,
					remoteConfigSettings?.remoteGlobalWorkflows,
					undefined,
					scriptCommands,
				)

				if (isValidCommand) {
					// Keep the prefix (whitespace or empty) and wrap the command in highlight
					return `${prefix}<mark class="mention-context-textarea-highlight">${command}</mark>`
				}
				return match
			})

			highlightLayerRef.current.innerHTML = processedText
			highlightLayerRef.current.scrollTop = textAreaRef.current.scrollTop
			highlightLayerRef.current.scrollLeft = textAreaRef.current.scrollLeft
		}, [localWorkflowToggles, globalWorkflowToggles, remoteWorkflowToggles, remoteConfigSettings, scriptCommands])

		useLayoutEffect(() => {
			updateHighlights()
		}, [inputValue, updateHighlights])

		const updateCursorPosition = useCallback(() => {
			if (textAreaRef.current) {
				setCursorPosition(textAreaRef.current.selectionStart)
			}
		}, [])

		const handleKeyUp = useCallback(
			(e: React.KeyboardEvent<HTMLTextAreaElement>) => {
				if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) {
					updateCursorPosition()
				}
			},
			[updateCursorPosition],
		)

		const onModeToggle = useCallback(() => {
			void (async () => {
				const convertedProtoMode = mode === "plan" ? PlanActMode.ACT : PlanActMode.PLAN
				const submittedText = inputValue
				const submittedImages = selectedImages
				const submittedFiles = selectedFiles
				const response = await StateServiceClient.togglePlanActModeProto(
					TogglePlanActModeRequest.create({
						mode: convertedProtoMode,
						chatContent: {
							message: submittedText.trim() ? submittedText : undefined,
							images: submittedImages,
							files: submittedFiles,
						},
					}),
				)
				// Focus the textarea after mode toggle with slight delay
				setTimeout(() => {
					const consumedComposerContent = response.value === true
					const currentText = textAreaRef.current?.value ?? ""
					// Reconcile only the submitted draft: the rebuild can take a moment
					// and the user may have typed new content in the meantime.
					const draftAction = getModeToggleDraftAction({
						consumed: consumedComposerContent,
						currentText,
						submittedText,
					})

					switch (draftAction) {
						case "clear":
							setInputValue("")
							break
						case "restore":
							setInputValue(submittedText)
							break
						case "keep":
							break
					}

					if (consumedComposerContent) {
						setSelectedImages((current) => (current === submittedImages ? [] : current))
						setSelectedFiles((current) => (current === submittedFiles ? [] : current))
					} else {
						if (submittedImages.length > 0) {
							setSelectedImages((current) => (current.length === 0 ? submittedImages : current))
						}
						if (submittedFiles.length > 0) {
							setSelectedFiles((current) => (current.length === 0 ? submittedFiles : current))
						}
					}
					textAreaRef.current?.focus()
				}, 100)
			})()
		}, [mode, inputValue, selectedImages, selectedFiles, setInputValue, setSelectedImages, setSelectedFiles])

		useShortcut(usePlatform().togglePlanActKeys, onModeToggle, { disableTextInputs: false }) // important that we don't disable the text input here

		// A `/ask` or `/act` command switches the mode from inside the textarea;
		// flash the toggle briefly so the switch is visible as it happens.
		useEffect(() => {
			const onModeSwitchedByCommand = () => setModeSwitchFlash(true)
			document.addEventListener(MODE_SWITCHED_BY_COMMAND_EVENT, onModeSwitchedByCommand)
			return () => document.removeEventListener(MODE_SWITCHED_BY_COMMAND_EVENT, onModeSwitchedByCommand)
		}, [])

		useEffect(() => {
			if (!modeSwitchFlash) {
				return
			}
			const timer = setTimeout(() => setModeSwitchFlash(false), 750)
			return () => clearTimeout(timer)
		}, [modeSwitchFlash])

		const handleContextButtonClick = useCallback(() => {
			// Focus the textarea first
			textAreaRef.current?.focus()

			// If input is empty, just insert @
			if (!inputValue.trim()) {
				const event = {
					target: {
						value: "@",
						selectionStart: 1,
					},
				} as React.ChangeEvent<HTMLTextAreaElement>
				handleInputChange(event)
				updateHighlights()
				return
			}

			// If input ends with space or is empty, just append @
			if (inputValue.endsWith(" ")) {
				const event = {
					target: {
						value: inputValue + "@",
						selectionStart: inputValue.length + 1,
					},
				} as React.ChangeEvent<HTMLTextAreaElement>
				handleInputChange(event)
				updateHighlights()
				return
			}

			// Otherwise add space then @
			const event = {
				target: {
					value: inputValue + " @",
					selectionStart: inputValue.length + 2,
				},
			} as React.ChangeEvent<HTMLTextAreaElement>
			handleInputChange(event)
			updateHighlights()
		}, [inputValue, handleInputChange, updateHighlights])

		const handleModelButtonClick = () => {
			navigateToSettingsModelPicker({ targetSection: "api-config" })
		}

		// Get model display name
		const modelDisplayName = useMemo(() => {
			const {
				vsCodeLmModelSelector,
				togetherModelId,
				lmStudioModelId,
				ollamaModelId,
				liteLlmModelId,
				requestyModelId,
				vercelAiGatewayModelId,
			} = getModeSpecificFields(apiConfiguration, mode)
			const unknownModel = "unknown"

			if (!apiConfiguration) {
				return unknownModel
			}
			switch (selectedProvider) {
				case "cline":
					return `${selectedProvider}:${selectedModelId}`
				case "cline-pass":
					// Free models selected on ClinePass go through Cline usage billing,
					// so label them the same way as the cline provider
					return selectedModelId.startsWith("cline-pass/")
						? `${selectedProvider}:${selectedModelId.replace(/^cline-pass\//, "")}`
						: `cline:${selectedModelId}`
				case "openai":
					return `openai-compat:${selectedModelId}`
				case "vscode-lm":
					return `vscode-lm:${vsCodeLmModelSelector ? `${vsCodeLmModelSelector.vendor ?? ""}/${vsCodeLmModelSelector.family ?? ""}` : unknownModel}`
				case "together":
					return `${selectedProvider}:${togetherModelId}`
				case "lmstudio":
					return `${selectedProvider}:${lmStudioModelId}`
				case "ollama":
					return `${selectedProvider}:${ollamaModelId}`
				case "litellm":
					return `${selectedProvider}:${liteLlmModelId}`
				case "requesty":
					return `${selectedProvider}:${requestyModelId}`
				case "vercel-ai-gateway":
					return `${selectedProvider}:${vercelAiGatewayModelId || selectedModelId}`
				case "anthropic":
				case "openrouter":
				default:
					return `${selectedProvider}:${selectedModelId}`
			}
		}, [apiConfiguration, mode, selectedProvider, selectedModelId])

		// Function to show error message for unsupported files for drag and drop
		const showUnsupportedFileErrorMessage = () => {
			// Show error message for unsupported files
			setShowUnsupportedFileError(true)

			// Clear any existing timer
			if (unsupportedFileTimerRef.current) {
				clearTimeout(unsupportedFileTimerRef.current)
			}

			// Set timer to hide error after 3 seconds
			unsupportedFileTimerRef.current = setTimeout(() => {
				setShowUnsupportedFileError(false)
				unsupportedFileTimerRef.current = null
			}, 3000)
		}

		const handleDragEnter = (e: React.DragEvent) => {
			e.preventDefault()
			setIsDraggingOver(true)

			// Check if files are being dragged
			if (e.dataTransfer.types.includes("Files")) {
				// Check if any of the files are not images
				const items = Array.from(e.dataTransfer.items)
				const hasNonImageFile = items.some((item) => {
					if (item.kind === "file") {
						const type = item.type.split("/")[0]
						return type !== "image"
					}
					return false
				})

				if (hasNonImageFile) {
					showUnsupportedFileErrorMessage()
				}
			}
		}
		/**
		 * Handles the drag over event to allow dropping.
		 * Prevents the default behavior to enable drop.
		 *
		 * @param {React.DragEvent} e - The drag event.
		 */
		const onDragOver = (e: React.DragEvent) => {
			e.preventDefault()
			// Ensure state remains true if dragging continues over the element
			if (!isDraggingOver) {
				setIsDraggingOver(true)
			}
		}

		const handleDragLeave = (e: React.DragEvent) => {
			e.preventDefault()
			// Check if the related target is still within the drop zone; prevents flickering
			const dropZone = e.currentTarget as HTMLElement
			if (!dropZone.contains(e.relatedTarget as Node)) {
				setIsDraggingOver(false)
				// Don't clear the error message here, let it time out naturally
			}
		}

		// Effect to detect when drag operation ends outside the component
		useEffect(() => {
			const handleGlobalDragEnd = () => {
				// This will be triggered when the drag operation ends anywhere
				setIsDraggingOver(false)
				// Don't clear error message, let it time out naturally
			}

			document.addEventListener("dragend", handleGlobalDragEnd)

			return () => {
				document.removeEventListener("dragend", handleGlobalDragEnd)
			}
		}, [])

		/**
		 * Handles the drop event for files and text.
		 * Processes dropped images and text, updating the state accordingly.
		 *
		 * @param {React.DragEvent} e - The drop event.
		 */
		const onDrop = async (e: React.DragEvent) => {
			e.preventDefault()
			setIsDraggingOver(false) // Reset state on drop

			// Clear any error message when something is actually dropped
			setShowUnsupportedFileError(false)
			if (unsupportedFileTimerRef.current) {
				clearTimeout(unsupportedFileTimerRef.current)
				unsupportedFileTimerRef.current = null
			}

			// --- 1. VSCode Explorer Drop Handling ---
			let uris: string[] = []
			const resourceUrlsData = e.dataTransfer.getData("resourceurls")
			const vscodeUriListData = e.dataTransfer.getData("application/vnd.code.uri-list")

			// 1a. Try 'resourceurls' first (used for multi-select)
			if (resourceUrlsData) {
				try {
					uris = JSON.parse(resourceUrlsData)
					uris = uris.map((uri) => decodeURIComponent(uri))
				} catch (error) {
					console.error("Failed to parse resourceurls JSON:", error)
					uris = [] // Reset if parsing failed
				}
			}

			// 1b. Fallback to 'application/vnd.code.uri-list' (newline separated)
			if (uris.length === 0 && vscodeUriListData) {
				uris = vscodeUriListData.split("\n").map((uri) => uri.trim())
			}

			// 1c. Filter for valid schemes (file or vscode-file) and non-empty strings
			const validUris = uris.filter(
				(uri) => uri && (uri.startsWith("vscode-file:") || uri.startsWith("file:") || uri.startsWith("vscode-remote:")),
			)

			if (validUris.length > 0) {
				setPendingInsertions([])
				let initialCursorPos = inputValue.length
				if (textAreaRef.current) {
					initialCursorPos = textAreaRef.current.selectionStart
				}
				setIntendedCursorPosition(initialCursorPos)

				FileServiceClient.getRelativePaths(RelativePathsRequest.create({ uris: validUris }))
					.then((response) => {
						if (response.paths.length > 0) {
							setPendingInsertions((prev) => [...prev, ...response.paths])
						}
					})
					.catch((error) => {
						console.error("Error getting relative paths:", error)
					})
				return
			}

			const text = e.dataTransfer.getData("text")
			if (text) {
				handleTextDrop(text)
				return
			}

			// --- 3. Image Drop Handling ---
			// Only proceed if it wasn't a VSCode resource or plain text drop
			const files = Array.from(e.dataTransfer.files)
			const acceptedTypes = ["png", "jpeg", "webp"]
			const imageFiles = files.filter((file) => {
				const [type, subtype] = file.type.split("/")
				return type === "image" && acceptedTypes.includes(subtype)
			})

			if (shouldDisableFilesAndImages || imageFiles.length === 0) {
				return
			}

			const imageDataArray = await readImageFiles(imageFiles)
			const dataUrls = imageDataArray.filter((dataUrl): dataUrl is string => dataUrl !== null)

			if (dataUrls.length > 0) {
				const filesAndImagesLength = selectedImages.length + selectedFiles.length
				const availableSlots = MAX_IMAGES_AND_FILES_PER_MESSAGE - filesAndImagesLength

				if (availableSlots > 0) {
					const imagesToAdd = Math.min(dataUrls.length, availableSlots)
					setSelectedImages((prevImages) => [...prevImages, ...dataUrls.slice(0, imagesToAdd)])
				}
			} else {
				console.warn("No valid images were processed")
			}
		}

		/**
		 * Handles the drop event for text.
		 * Inserts the dropped text at the current cursor position.
		 *
		 * @param {string} text - The dropped text.
		 */
		const handleTextDrop = (text: string) => {
			const newValue = inputValue.slice(0, cursorPosition) + text + inputValue.slice(cursorPosition)
			setInputValue(newValue)
			const newCursorPosition = cursorPosition + text.length
			setCursorPosition(newCursorPosition)
			setIntendedCursorPosition(newCursorPosition)
		}

		/**
		 * Reads image files and returns their data URLs.
		 * Uses FileReader to read the files as data URLs.
		 *
		 * @param {File[]} imageFiles - The image files to read.
		 * @returns {Promise<(string | null)[]>} - A promise that resolves to an array of data URLs or null values.
		 */
		const readImageFiles = (imageFiles: File[]): Promise<(string | null)[]> => {
			return Promise.all(
				imageFiles.map(
					(file) =>
						new Promise<string | null>((resolve) => {
							const reader = new FileReader()
							reader.onloadend = async () => {
								// Make async
								if (reader.error) {
									console.error("Error reading file:", reader.error)
									resolve(null)
								} else {
									const result = reader.result
									if (typeof result === "string") {
										try {
											await getImageDimensions(result) // Check dimensions
											resolve(result)
										} catch (error) {
											console.warn((error as Error).message)
											showDimensionErrorMessage() // Show error to user
											resolve(null) // Don't add this image
										}
									} else {
										resolve(null)
									}
								}
							}
							reader.readAsDataURL(file)
						}),
				),
			)
		}
		// Replace Meta with the platform specific key and uppercase the command letter.
		const togglePlanActKeys = usePlatform()
			.togglePlanActKeys.replace("Meta", metaKeyChar)
			.replace(/.$/, (match) => match.toUpperCase())

		const whereHasTask = useWherePillHasTask()
		const rowLayout = useComposerRowLayout(bottomRowRef, {
			hasUsage: !!usageIndicator,
			hasCost: !!usageIndicator?.hasCost,
			hasCompactNudge: !!usageIndicator?.hasCompactNudge,
			hasEffort: modelHasReasoning(selectedModelId, selectedModelInfo),
			hasTask: whereHasTask,
		})

		return (
			<div>
				{scriptInput && (
					<ScriptHelper
						onChange={(next) => {
							const text = `${scriptInput.prefix}${next}${scriptInput.suffix}`
							const cursor = scriptInput.prefix.length + next.length
							setInputValue(text)
							setCursorPosition(cursor)
							setIntendedCursorPosition(cursor)
							setTimeout(() => textAreaRef.current?.focus(), 0)
						}}
						optionsText={scriptInput.optionsText}
						script={scriptInput.script}
					/>
				)}
				<div
					className="relative flex transition-colors ease-in-out duration-100 px-3.5 py-2.5"
					onDragEnter={handleDragEnter}
					onDragLeave={handleDragLeave}
					onDragOver={onDragOver}
					onDrop={onDrop}>
					{showDimensionError && (
						<div className="absolute inset-2.5 bg-[rgba(var(--vscode-errorForeground-rgb),0.1)] border-2 border-error rounded-xs flex items-center justify-center z-10 pointer-events-none">
							<span className="text-error font-bold text-xs text-center">Image dimensions exceed 7500px</span>
						</div>
					)}
					{showUnsupportedFileError && (
						<div className="absolute inset-2.5 bg-[rgba(var(--vscode-errorForeground-rgb),0.1)] border-2 border-error rounded-xs flex items-center justify-center z-10 pointer-events-none">
							<span className="text-error font-bold text-xs">Files other than images are currently disabled</span>
						</div>
					)}
					{showSlashCommandsMenu && (
						<div ref={slashCommandsMenuContainerRef}>
							<SlashCommandMenu
								globalWorkflowToggles={globalWorkflowToggles}
								localWorkflowToggles={localWorkflowToggles}
								mcpServers={mcpServers}
								onMouseDown={handleMenuMouseDown}
								onSelect={handleSlashCommandsSelect}
								query={slashCommandsQuery}
								remoteWorkflows={remoteConfigSettings?.remoteGlobalWorkflows}
								remoteWorkflowToggles={remoteWorkflowToggles}
								scriptCommands={menuScriptCommands}
								selectedIndex={selectedSlashCommandsIndex}
								setSelectedIndex={setSelectedSlashCommandsIndex}
							/>
						</div>
					)}

					{showNoteMentionMenu && (
						<NoteMentionMenu
							notes={noteMatches}
							onSelect={handleNoteMentionSelect}
							selectedIndex={selectedNoteIndex}
							setSelectedIndex={setSelectedNoteIndex}
						/>
					)}

					{showThreadMentionMenu && (
						<ThreadMentionMenu
							onSelect={handleThreadMentionSelect}
							selectedIndex={selectedThreadIndex}
							setSelectedIndex={setSelectedThreadIndex}
							threads={threadMatches}
						/>
					)}

					{showContextMenu && (
						<div ref={contextMenuContainerRef}>
							<ContextMenu
								dynamicSearchResults={fileSearchResults}
								isLoading={searchLoading}
								onMouseDown={handleMenuMouseDown}
								onSelect={handleMentionSelect}
								queryItems={queryItems}
								searchQuery={searchQuery}
								selectedIndex={selectedMenuIndex}
								selectedType={selectedType}
								setSelectedIndex={setSelectedMenuIndex}
							/>
						</div>
					)}
					<div
						className={cn(
							"absolute bottom-2.5 top-2.5 whitespace-pre-wrap break-words rounded-xs overflow-hidden bg-input-background",
							isTextAreaFocused ? "left-3.5 right-3.5" : "left-3.5 right-3.5 border border-input-border",
						)}
						ref={highlightLayerRef}
						style={{
							position: "absolute",
							pointerEvents: "none",
							whiteSpace: "pre-wrap",
							wordWrap: "break-word",
							color: "transparent",
							overflow: "hidden",
							fontFamily: "var(--vscode-font-family)",
							fontSize: "var(--vscode-editor-font-size)",
							lineHeight: "var(--vscode-editor-line-height)",
							borderRadius: 2,
							borderLeft: isTextAreaFocused ? 0 : undefined,
							borderRight: isTextAreaFocused ? 0 : undefined,
							borderTop: isTextAreaFocused ? 0 : undefined,
							borderBottom: isTextAreaFocused ? 0 : undefined,
							padding: `${9 + quoteRowHeight}px ${inputPaddingRight}px ${9 + thumbnailsHeight}px 9px`,
						}}
					/>
					<DynamicTextArea
						autoFocus={true}
						data-testid="chat-input"
						maxRows={10}
						minRows={3}
						onBlur={handleBlur}
						onChange={(e) => {
							handleInputChange(e)
							updateHighlights()
						}}
						onFocus={() => {
							setIsTextAreaFocused(true)
							onFocusChange?.(true) // Call prop on focus
						}}
						onHeightChange={(height) => {
							if (textAreaBaseHeight === undefined || height < textAreaBaseHeight) {
								setTextAreaBaseHeight(height)
							}
							onHeightChange?.(height)
						}}
						onKeyDown={handleKeyDown}
						onKeyUp={handleKeyUp}
						onMouseUp={updateCursorPosition}
						onPaste={handlePaste}
						onScroll={() => updateHighlights()}
						onSelect={updateCursorPosition}
						placeholder={showUnsupportedFileError || showDimensionError ? "" : placeholderText}
						ref={(el) => {
							if (typeof ref === "function") {
								ref(el)
							} else if (ref) {
								ref.current = el
							}
							textAreaRef.current = el
						}}
						style={{
							width: "100%",
							boxSizing: "border-box",
							backgroundColor: "transparent",
							color: "var(--vscode-input-foreground)",
							//border: "1px solid var(--vscode-input-border)",
							borderRadius: 2,
							fontFamily: "var(--vscode-font-family)",
							fontSize: "var(--vscode-editor-font-size)",
							lineHeight: "var(--vscode-editor-line-height)",
							resize: "none",
							overflowX: "hidden",
							overflowY: "scroll",
							scrollbarWidth: "none",
							// Since we have maxRows, when text is long enough it starts to overflow the bottom padding, appearing behind the thumbnails. To fix this, we use a transparent border to push the text up instead. (https://stackoverflow.com/questions/42631947/maintaining-a-padding-inside-of-text-area/52538410#52538410)
							// borderTop: "9px solid transparent",
							borderLeft: 0,
							borderRight: 0,
							borderTop: `${quoteRowHeight}px solid transparent`,
							borderBottom: `${thumbnailsHeight}px solid transparent`,
							borderColor: "transparent",
							// borderRight: "54px solid transparent",
							// borderLeft: "9px solid transparent", // NOTE: react-textarea-autosize doesn't calculate correct height when using borderLeft/borderRight so we need to use horizontal padding instead
							// Instead of using boxShadow, we use a div with a border to better replicate the behavior when the textarea is focused
							// boxShadow: "0px 0px 0px 1px var(--vscode-input-border)",
							padding: `9px ${inputPaddingRight}px 9px 9px`,
							cursor: "text",
							flex: 1,
							zIndex: 1,
							outline:
								isDraggingOver && !showUnsupportedFileError // Only show drag outline if not showing error
									? "2px dashed var(--vscode-focusBorder)"
									: isTextAreaFocused
										? `1px solid ${mode === "plan" ? PLAN_MODE_COLOR : "var(--vscode-focusBorder)"}`
										: "none",
							outlineOffset: isDraggingOver && !showUnsupportedFileError ? "1px" : "0px", // Add offset for drag-over outline
						}}
						value={inputValue}
					/>
					{quoteTags && (
						<div className="absolute top-3.5 left-5.5 right-5.5 z-2 h-5" data-testid="composer-quote-row">
							{quoteTags}
						</div>
					)}
					{!inputValue && selectedImages.length === 0 && selectedFiles.length === 0 && (
						<div className="text-xs absolute bottom-5 left-6.5 right-16 text-(--vscode-input-placeholderForeground)/50 whitespace-nowrap overflow-hidden text-ellipsis pointer-events-none z-1">
							Type @ for context, / for slash commands & workflows, hold shift to drag in files/images
						</div>
					)}
					{(selectedImages.length > 0 || selectedFiles.length > 0) && (
						<Thumbnails
							files={selectedFiles}
							images={selectedImages}
							imagesUnsupported={unsupportedImagesAttached}
							onHeightChange={handleThumbnailsHeightChange}
							setFiles={setSelectedFiles}
							setImages={setSelectedImages}
							style={{
								position: "absolute",
								paddingTop: 4,
								bottom: 14,
								left: 22,
								right: 47, // (54 + 9) + 4 extra padding
								zIndex: 2,
							}}
						/>
					)}
					<div
						className="absolute flex items-end bottom-4.5 right-5 z-10 h-8 text-xs"
						style={{ height: textAreaBaseHeight }}>
						<div className="flex flex-row items-center">
							{onRestoreStash && onDeleteStash && (
								<PromptStashButton
									entries={stashEntries}
									modKey={metaKeyChar}
									onDelete={onDeleteStash}
									onRestore={onRestoreStash}
								/>
							)}
							{showRunningSendButtons && onSendAs ? (
								<RunningSendButtons
									disabled={sendDisabled}
									enterSendsAs={enterSendsAs}
									metaKeyChar={metaKeyChar}
									onInterject={() => onSendAs("interject")}
									onSteer={onSend}
								/>
							) : (
								<div className="flex items-center gap-0.5">
									{showHomeBackgroundButton && (
										<Tooltip>
											<TooltipContent side="top">
												Start in background ({metaKeyChar}+Enter): the chat keeps running while you stay
												here
											</TooltipContent>
											<TooltipTrigger asChild>
												<button
													aria-label="Start in background"
													className="flex size-5 items-center justify-center rounded-xs border-0 bg-transparent p-0 cursor-pointer text-description hover:bg-toolbar-hover hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
													data-testid="send-background-button"
													disabled={sendDisabled}
													onClick={() => onSendAs("background")}
													type="button">
													<SendToBackIcon size={13} />
												</button>
											</TooltipTrigger>
										</Tooltip>
									)}
									<div
										className={cn(
											"input-icon-button",
											{ disabled: sendDisabled },
											"codicon codicon-send text-sm",
										)}
										data-testid="send-button"
										onClick={() => {
											if (!sendDisabled) {
												onSend()
											}
										}}
										title={
											isHome
												? `Send (Enter) · Start in background (${metaKeyChar}+Enter)`
												: "Send (Enter) · Aside (Alt+Enter)"
										}
									/>
								</div>
							)}
						</div>
					</div>
				</div>
				{unsupportedImagesAttached && (
					<div
						className="flex items-center gap-1.5 px-3.5 pb-1.5 text-xs"
						data-testid="images-unsupported-notice"
						role="status"
						style={{ color: "var(--vscode-editorWarning-foreground)" }}>
						<TriangleAlertIcon className="shrink-0" size={12} />
						<span className="min-w-0">
							{selectedModelId} doesn't support images, so{" "}
							{selectedImages.length === 1 ? "the attached image" : `the ${selectedImages.length} attached images`}{" "}
							will be ignored.{" "}
							<button
								className="underline cursor-pointer bg-transparent border-0 p-0 m-0 text-[var(--vscode-textLink-foreground)] hover:text-[var(--vscode-textLink-activeForeground)]"
								data-testid="images-unsupported-choose-model"
								onClick={handleModelButtonClick}
								type="button">
								Choose an image-capable model
							</button>{" "}
							or remove {selectedImages.length === 1 ? "it" : "them"}.
						</span>
					</div>
				)}
				<DetectedTicketChips text={inputValue} />
				<ComposerTaskGroupSheet draftText={inputValue} />
				<div
					className="flex items-center gap-1.5 flex-nowrap min-w-0 -mt-[2px] px-3 pb-2"
					data-testid="composer-bottom-row"
					ref={bottomRowRef}>
					<ButtonGroup className="h-5" data-testid="composer-pickers">
						<PlusMenu
							filesDisabled={shouldDisableFilesAndImages}
							foldedPanels={!rowLayout.inlinePanelButtons}
							onAddFiles={() => {
								if (!shouldDisableFilesAndImages) {
									onSelectFilesAndImages()
								}
							}}
							onMention={handleContextButtonClick}
							onUseScript={startScriptDraft}
						/>
						{rowLayout.inlinePanelButtons && (
							<>
								<McpServersButton />
								<RulesButton onUseScript={startScriptDraft} />
							</>
						)}
						<WorkspaceButton />
						{/* No task: the icon alone, never squeezed. A task name shrinks to a few characters, then to the icon when tight. */}
						{whereHasTask ? (
							<ShrinkSlot floor={rowLayout.tightPills ? 22 : 52}>
								<WherePill iconOnly={rowLayout.tightPills} onOpenTaskGroup={onOpenTaskGroup} />
							</ShrinkSlot>
						) : (
							<span className="flex shrink-0 empty:hidden">
								<WherePill iconOnly={rowLayout.tightPills} onOpenTaskGroup={onOpenTaskGroup} />
							</span>
						)}
						{/* Tight rows let the pickers go below their usual minimums before the MCP and rules buttons fold. */}
						<ShrinkSlot floor={rowLayout.tightPills ? 40 : 72}>
							<ConfigPicker fallbackLabel={modelDisplayName} mode={mode} />
						</ShrinkSlot>
						{/* Effort labels are short ("Default", "Med"): the long model name gives way first. */}
						<ShrinkSlot floor={rowLayout.tightPills ? 28 : 60} shrink={0.2}>
							<ReasoningEffortPicker
								defaultEffort={selectedProvider === "openai-native" ? "medium" : "none"}
								mode={mode}
								modelId={selectedModelId}
								modelInfo={selectedModelInfo}
							/>
						</ShrinkSlot>
						<ApprovalsMenu />
					</ButtonGroup>
					{usageIndicator && <div className="flex items-center shrink-0">{usageIndicator.render(rowLayout)}</div>}
					{/* Tooltip for Ask/Act toggle remains outside the conditional rendering. Internal mode value stays "plan". */}
					<Tooltip>
						<TooltipContent
							className="text-xs px-2 flex flex-col gap-1"
							hidden={shownTooltipMode === null}
							side="top">
							{shownTooltipMode === "act"
								? "In Act mode, Cline will complete the task immediately"
								: "In Ask mode, Cline will answer questions and explore the codebase"}
							<p className="text-description/80 text-xs mb-0">
								Toggle w/ <kbd className="text-muted-foreground mx-1">{togglePlanActKeys}</kbd>
							</p>
						</TooltipContent>
						<TooltipTrigger className="shrink-0">
							<SwitchContainer
								$flash={modeSwitchFlash}
								data-testid="mode-switch"
								disabled={false}
								onClick={onModeToggle}>
								<Slider isAct={mode === "act"} isPlan={mode === "plan"} />
								{(
									[
										{ value: "plan", label: "Ask" },
										{ value: "act", label: "Act" },
									] as const
								).map((m) => (
									<div
										aria-checked={mode === m.value}
										className={cn(
											"pt-0.5 pb-px px-2 z-10 text-xs w-1/2 text-center bg-transparent transition-colors duration-200 motion-reduce:transition-none [.vscode-reduce-motion_&]:transition-none",
											mode === m.value ? "text-button-foreground" : "text-input-foreground",
										)}
										key={m.value}
										onMouseLeave={() => setShownTooltipMode(null)}
										onMouseOver={() => setShownTooltipMode(m.value)}
										role="switch">
										{m.label}
									</div>
								))}
							</SwitchContainer>
						</TooltipTrigger>
					</Tooltip>
				</div>
			</div>
		)
	},
)

export default ChatTextArea
