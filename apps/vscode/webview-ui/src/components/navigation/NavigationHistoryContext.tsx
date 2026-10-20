import type React from "react"
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react"
import { openTask } from "@/components/inbox/sessionActions"
import { resolveSettingsTarget, type SettingsNavigationTarget } from "@/components/settings/settingsTargets"
import { useExtensionState } from "@/context/ExtensionStateContext"
import {
	backTarget,
	describeLocation,
	HOME,
	jumpToLocation,
	type LocationLabel,
	type NavLocation,
	popLocation,
	pushLocation,
	sameLocation,
} from "./navHistory"

/** What ChatView lends the history layer: its thread and search state live there. */
export interface ChatNavigationControls {
	closeThread: () => void
	openSearch: (query: string) => void
	closeSearch: () => void
}

export interface NavigationHistory {
	/** Oldest first; the last entry is the current place. */
	entries: NavLocation[]
	current: NavLocation
	/** Where Back goes, if anywhere. */
	backTarget?: NavLocation
	back: () => void
	/** Jumps to an earlier entry from the history list. */
	jumpTo: (index: number) => void
	/** Goes somewhere and records it, ignoring the in-between screens on the way. */
	navigate: (location: NavLocation) => void
	describe: (location: NavLocation) => LocationLabel
	registerChat: (controls: ChatNavigationControls) => () => void
	reportSearch: (open: boolean, query?: string) => void
	reportSettingsSection: (section: string | undefined) => void
}

const NavigationHistoryContext = createContext<NavigationHistory | undefined>(undefined)

/** The history layer, or undefined outside the provider (isolated component tests). */
export function useNavigationHistory(): NavigationHistory | undefined {
	return useContext(NavigationHistoryContext)
}

// A restore runs several state changes (close the overlay, then open the thread
// over RPC); screens seen on the way there aren't visits.
const RESTORE_WINDOW_MS = 2000

interface ViewState {
	showSettings: boolean
	settingsSection?: string
	showHistory: boolean
	showMarketplace: boolean
	showMcp: boolean
	showAccount: boolean
	showWorktrees: boolean
	showWalkthrough?: boolean
	/** Set when the open walkthrough page shows an agent-authored doc, not the thread diff. */
	walkthroughAuthoredId?: string
	taskGroupView: { id: string; page: "home" | "notebook" } | null
	threadId?: string
	searchOpen: boolean
}

/** The place on screen, in the order App and ChatView pick what to render. */
export function deriveLocation(view: ViewState): NavLocation {
	if (view.showSettings) return { kind: "settings", section: view.settingsSection }
	if (view.showHistory) return { kind: "history" }
	if (view.showMarketplace) return { kind: "marketplace" }
	if (view.showMcp) return { kind: "mcp" }
	if (view.showAccount) return { kind: "account" }
	if (view.showWalkthrough && view.threadId)
		return { kind: "walkthrough", id: view.threadId, authoredId: view.walkthroughAuthoredId }
	if (view.showWorktrees) return { kind: "worktrees" }
	if (view.taskGroupView) return { kind: "task", id: view.taskGroupView.id, page: view.taskGroupView.page }
	if (view.threadId) return { kind: "thread", id: view.threadId }
	if (view.searchOpen) return { kind: "search" }
	return HOME
}

export const NavigationHistoryProvider = ({ children }: { children: React.ReactNode }) => {
	const state = useExtensionState()
	const {
		showSettings,
		settingsNavigationRequest,
		showHistory,
		showMarketplace,
		showMcp,
		showAccount,
		showWorktrees,
		showWalkthrough,
		walkthroughAuthoredId,
		taskGroupView,
		currentTaskItem,
		taskHistory,
		taskGroups,
	} = state
	const [searchOpen, setSearchOpen] = useState(false)
	const [settingsSection, setSettingsSection] = useState<string>()
	const searchQueryRef = useRef("")
	const chatRef = useRef<ChatNavigationControls>()
	const pendingRef = useRef<{ location: NavLocation; until: number }>()
	const actionsRef = useRef(state)
	actionsRef.current = state

	// Before SettingsView reports its tab, it opens on the requested one (or the first).
	const section = settingsSection ?? resolveSettingsTarget(settingsNavigationRequest?.target)?.tabId ?? "api-config"
	const current = useMemo(
		() =>
			deriveLocation({
				showSettings,
				settingsSection: section,
				showHistory,
				showMarketplace,
				showMcp,
				showAccount,
				showWorktrees,
				showWalkthrough,
				walkthroughAuthoredId,
				taskGroupView,
				threadId: currentTaskItem?.id,
				searchOpen,
			}),
		[
			showSettings,
			section,
			showHistory,
			showMarketplace,
			showMcp,
			showAccount,
			showWorktrees,
			showWalkthrough,
			walkthroughAuthoredId,
			taskGroupView,
			currentTaskItem?.id,
			searchOpen,
		],
	)

	const [entries, setEntries] = useState<NavLocation[]>([current])

	useEffect(() => {
		const pending = pendingRef.current
		if (pending) {
			if (sameLocation(pending.location, current) || Date.now() > pending.until) {
				pendingRef.current = undefined
			} else {
				return
			}
		}
		setEntries((previous) => pushLocation(previous, current))
	}, [current])

	const goTo = useCallback((location: NavLocation) => {
		const actions = actionsRef.current
		const chat = chatRef.current
		const threadOpen = !!actions.currentTaskItem
		pendingRef.current = { location, until: Date.now() + RESTORE_WINDOW_MS }
		switch (location.kind) {
			case "settings":
				actions.navigateToSettings(location.section as SettingsNavigationTarget | undefined)
				return
			case "history":
				actions.navigateToHistory()
				return
			case "account":
				actions.navigateToAccount()
				return
			case "worktrees":
				actions.navigateToWorktrees()
				return
			case "marketplace":
				actions.navigateToMarketplace()
				return
			case "mcp":
				actions.navigateToChat()
				actions.setShowMcp(true)
				return
			case "task":
				actions.navigateToTaskGroup(location.id, location.page)
				return
			case "walkthrough":
				actions.navigateToWalkthrough(location.authoredId)
				if (actions.currentTaskItem?.id !== location.id) void openTask(location.id)
				return
			case "thread":
				actions.navigateToChat()
				chat?.closeSearch()
				if (actions.currentTaskItem?.id !== location.id) void openTask(location.id)
				return
			case "search":
				actions.navigateToChat()
				if (threadOpen) chat?.closeThread()
				chat?.openSearch(searchQueryRef.current)
				return
			case "home":
				actions.navigateToChat()
				chat?.closeSearch()
				if (threadOpen) chat?.closeThread()
				return
		}
	}, [])

	const restore = useCallback(
		(next: NavLocation[] | undefined) => {
			if (!next) return
			setEntries(next)
			goTo(next[next.length - 1])
		},
		[goTo],
	)

	const back = useCallback(() => restore(popLocation(entries)), [entries, restore])
	const jumpTo = useCallback((index: number) => restore(jumpToLocation(entries, index)), [entries, restore])
	const navigate = useCallback(
		(location: NavLocation) => {
			if (sameLocation(location, current)) return
			goTo(location)
		},
		[current, goTo],
	)

	const describe = useCallback(
		(location: NavLocation) => describeLocation(location, taskHistory ?? [], taskGroups ?? []),
		[taskHistory, taskGroups],
	)

	const registerChat = useCallback((controls: ChatNavigationControls) => {
		chatRef.current = controls
		return () => {
			if (chatRef.current === controls) chatRef.current = undefined
		}
	}, [])
	const reportSearch = useCallback((open: boolean, query?: string) => {
		setSearchOpen(open)
		if (query !== undefined) searchQueryRef.current = query
	}, [])
	const reportSettingsSection = useCallback((next: string | undefined) => setSettingsSection(next), [])

	const value = useMemo<NavigationHistory>(
		() => ({
			entries,
			current,
			backTarget: backTarget(entries),
			back,
			jumpTo,
			navigate,
			describe,
			registerChat,
			reportSearch,
			reportSettingsSection,
		}),
		[entries, current, back, jumpTo, navigate, describe, registerChat, reportSearch, reportSettingsSection],
	)

	return <NavigationHistoryContext.Provider value={value}>{children}</NavigationHistoryContext.Provider>
}
