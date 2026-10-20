import { StringRequest } from "@shared/proto/cline/common"
import type {
	ChangeWalkthrough,
	WalkthroughHunk,
	WalkthroughRequest,
	WalkthroughScope,
	WalkthroughStop,
} from "@shared/Walkthrough"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { buildThreadPath } from "@/components/chat/chat-view/utils/threadUtils"
import { handleMenuKeyDown } from "@/components/chat/composer/menuKeyboard"
import { Breadcrumb, type Crumb } from "@/components/chat/task-header/Breadcrumb"
import { HeaderIconButton } from "@/components/chat/task-header/HeaderIconButton"
import { InlineNotice } from "@/components/common/InlineNotice"
import { LinkButton } from "@/components/common/LinkButton"
import { MENU_ICON_CLASS, MENU_ITEM_CLASS, MENU_SEPARATOR_CLASS } from "@/components/common/menuStyles"
import { useNavigationHistory } from "@/components/navigation/NavigationHistoryContext"
import { describeProfile } from "@/components/settings/apiProfiles/profileDraft"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { cn } from "@/lib/utils"
import { TaskServiceClient } from "@/services/grpc-client"
import { GenerateControl } from "./GenerateControl"
import {
	carryOverReview,
	discardUnplacedNotes,
	dropStale,
	loadReviewStore,
	migrateRegeneratedReview,
	notesToSend,
	type ReviewRecord,
	type ReviewStore,
	recoverUnplacedNotes,
	type StopReview,
	saveReviewStore,
	stopReviewFor,
	summarizeStale,
	unplacedNotes,
} from "./reviewState"
import { InlineCodeProse, NoteEditor, NoteQuote, type RevertTarget, WalkthroughStopCard } from "./WalkthroughStopCard"
import { countChanges, EMPTY_FOLDS, type Folds, foldAll, supportSummary, unfoldAll } from "./walkthroughUtils"

const request = (value: WalkthroughRequest) => StringRequest.create({ value: JSON.stringify(value) })
const parse = (response: { value: string }) => JSON.parse(response.value) as ChangeWalkthrough
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`

const SCOPES: { scope: WalkthroughScope; label: string }[] = [
	{ scope: "thread", label: "This thread" },
	{ scope: "last_turn", label: "Last turn" },
	{ scope: "git", label: "Whole git diff" },
]

// While the page is open, the agent may keep editing; re-check the diff after activity settles.
const RECHECK_DELAY_MS = 1200

const EMPTY_HINT: Record<WalkthroughScope, string> = {
	thread: "This thread hasn't changed any files.",
	last_turn: "The last turn didn't change any files.",
	git: "No uncommitted changes in the workspace.",
}

/**
 * `Task › Thread › Walkthrough`: the thread's changes as one long scroll of
 * chapters and stops. Free by default (grouped by turn); Generate is the only
 * AI-cost action and runs only when clicked. Notes go to the thread as one message.
 */
export default function WalkthroughView({ taskId, onDone }: { taskId: string; onDone: () => void }) {
	const {
		apiConfigProfiles,
		profiles: namedProfiles,
		walkthroughGenerateProfileId,
		currentTaskItem,
		taskHistory,
		taskGroups,
		navigateToTaskGroup,
		navigateToSettings,
		windowFocused,
		clineMessages,
	} = useExtensionState()
	const navigation = useNavigationHistory()
	const [scope, setScope] = useState<WalkthroughScope>("thread")
	const [walk, setWalk] = useState<ChangeWalkthrough>()
	const [store, setStore] = useState<ReviewStore>(() => loadReviewStore(taskId, "thread"))
	const [loading, setLoading] = useState(true)
	const [generating, setGenerating] = useState(false)
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState("")
	// Set when a background check finds a different diff than the one on screen.
	const [moved, setMoved] = useState(false)
	const [pickedProfileId, setPickedProfileId] = useState<string>()
	// Fold state per scope and layout, kept while the page is open (not persisted).
	const [foldsByWalk, setFoldsByWalk] = useState<Record<string, Folds>>({})
	const [overallOpen, setOverallOpen] = useState(false)
	const [menuOpen, setMenuOpen] = useState(false)
	const sequence = useRef(0)
	// Generate finishes long after it starts; it must merge into the latest notes, not a stale render's.
	const storeRef = useRef(store)
	storeRef.current = store

	// Generate runs on a profile (Settings › Profiles): its model at its effort.
	const profiles = useMemo(
		() =>
			(namedProfiles ?? []).map((profile) => {
				const configuration = apiConfigProfiles?.find((c) => c.id === profile.configurationId)
				return {
					id: profile.id,
					name: profile.name,
					description: [
						configuration ? describeProfile(configuration) : "Missing model",
						profile.reasoningEffort && `${profile.reasoningEffort} effort`,
					]
						.filter(Boolean)
						.join(" · "),
				}
			}),
		[namedProfiles, apiConfigProfiles],
	)
	const profileId =
		pickedProfileId ??
		(profiles.some((p) => p.id === walkthroughGenerateProfileId) ? walkthroughGenerateProfileId : undefined)

	const fetchFree = useCallback(
		async (forScope: WalkthroughScope) =>
			parse(await TaskServiceClient.getChangeWalkthrough(request({ taskId, scope: forScope }))),
		[taskId],
	)

	const persist = useCallback(
		(next: ReviewStore) => {
			storeRef.current = next
			saveReviewStore(taskId, scope, next)
			setStore(next)
		},
		[taskId, scope],
	)

	// Each scope has its own walkthrough and review state.
	useEffect(() => {
		const id = ++sequence.current
		setWalk(undefined)
		setMoved(false)
		setError("")
		setLoading(true)
		setStore(loadReviewStore(taskId, scope))
		fetchFree(scope)
			.then((next) => id === sequence.current && setWalk(next))
			.catch((err) => id === sequence.current && setError(message(err)))
			.finally(() => id === sequence.current && setLoading(false))
		return () => {
			sequence.current++
		}
	}, [taskId, scope, fetchFree])

	const checkMoved = useCallback(async () => {
		if (!walk) return
		const id = sequence.current
		try {
			const next = await fetchFree(scope)
			if (id === sequence.current && next.fingerprint !== walk.fingerprint) setMoved(true)
		} catch {
			// A failed background check changes nothing on screen.
		}
	}, [walk, scope, fetchFree])

	const messageCount = clineMessages?.length ?? 0
	const firstCheck = useRef(true)
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-check on focus and on new thread activity only
	useEffect(() => {
		if (firstCheck.current) {
			firstCheck.current = false
			return
		}
		if (!walk || loading || busy || generating || moved || windowFocused === false) return
		const timer = setTimeout(() => void checkMoved(), RECHECK_DELAY_MS)
		return () => clearTimeout(timer)
	}, [windowFocused, messageCount])

	const run = async (operation: () => Promise<void>): Promise<boolean> => {
		setBusy(true)
		setError("")
		try {
			await operation()
			return true
		} catch (err) {
			const text = message(err)
			setError(text)
			if (/changes moved/i.test(text)) void checkMoved()
			return false
		} finally {
			setBusy(false)
		}
	}

	const refresh = () =>
		run(async () => {
			const id = ++sequence.current
			const next = await fetchFree(scope)
			if (id !== sequence.current) return
			setWalk(next)
			setMoved(false)
			persist(dropStale(store, next.fingerprint))
		})

	const generate = async () => {
		if (!walk || !profileId) return
		const regenerate = walk.source === "generated"
		setGenerating(true)
		setError("")
		try {
			const id = ++sequence.current
			const next = parse(
				await TaskServiceClient.generateChangeWalkthrough(
					request({ taskId, scope, fingerprint: walk.fingerprint, profileId, regenerate }),
				),
			)
			if (id !== sequence.current) return
			// A regenerated layout reuses stop ids for different stops: notes follow their
			// stop where one matches, and the rest wait in the banner (never dropped).
			if (regenerate) persist(migrateRegeneratedReview(storeRef.current, walk, next))
			setWalk(next)
			setMoved(false)
		} catch (err) {
			setError(message(err))
		} finally {
			setGenerating(false)
		}
	}

	const review: StopReview = walk ? stopReviewFor(store, walk) : { notes: {}, reviewed: {} }
	const record: ReviewRecord = walk ? (store[walk.fingerprint] ?? {}) : {}
	const overallNote = record.overallNote ?? ""

	const updateRecord = (change: (current: ReviewRecord) => ReviewRecord) => {
		if (!walk) return
		persist({ ...store, [walk.fingerprint]: change(store[walk.fingerprint] ?? {}) })
	}
	const updateStop = (stopId: string, change: Partial<{ note: string; reviewed: boolean }>) =>
		updateRecord((current) => {
			const stops = walk ? (current[walk.source] ?? { notes: {}, reviewed: {} }) : { notes: {}, reviewed: {} }
			const next: StopReview = {
				notes: change.note === undefined ? stops.notes : { ...stops.notes, [stopId]: change.note },
				reviewed: change.reviewed === undefined ? stops.reviewed : { ...stops.reviewed, [stopId]: change.reviewed },
			}
			return walk ? { ...current, [walk.source]: next } : current
		})

	const foldKey = walk ? `${scope}:${walk.source}` : ""
	const folds = foldsByWalk[foldKey] ?? EMPTY_FOLDS
	const setFolds = (change: (current: Folds) => Folds) =>
		setFoldsByWalk((all) => ({ ...all, [foldKey]: change(all[foldKey] ?? EMPTY_FOLDS) }))
	const toggleChapter = (chapterId: string) =>
		setFolds((current) => ({
			...current,
			collapsedChapters: { ...current.collapsedChapters, [chapterId]: !current.collapsedChapters[chapterId] },
		}))
	const collapseAll = () => walk && setFolds(() => foldAll(walk))
	const expandAll = () => setFolds(unfoldAll)

	const input = walk ? { taskId, scope, fingerprint: walk.fingerprint } : undefined
	const actions = {
		busy: busy || generating || moved,
		hunkOpen: (hunk: WalkthroughHunk) => !folds.collapsedHunks[hunk.fingerprint],
		toggleHunk: (hunk: WalkthroughHunk) =>
			setFolds((current) => ({
				...current,
				collapsedHunks: { ...current.collapsedHunks, [hunk.fingerprint]: !current.collapsedHunks[hunk.fingerprint] },
			})),
		openDiff: (fileId: string) => {
			if (input) void run(async () => void (await TaskServiceClient.openWalkthroughDiff(request({ ...input, fileId }))))
		},
		revert: (target: RevertTarget) =>
			run(async () => {
				if (!input || !walk) return
				const id = ++sequence.current
				const next = parse(
					await TaskServiceClient.revertWalkthroughChange(request({ ...input, ...target, confirmed: true })),
				)
				if (id !== sequence.current) return
				// The revert is the user's own move: keep what still maps onto the new stops.
				persist(carryOverReview(store, walk, next))
				setWalk(next)
				setMoved(false)
			}),
	}

	const sending = notesToSend(walk ?? EMPTY_WALK, review, overallNote)
	const send = () =>
		run(async () => {
			if (!input || !walk || !sending.count) return
			await TaskServiceClient.sendWalkthroughNotes(
				request({ ...input, stopNotes: sending.stopNotes, overallNote: sending.overallNote }),
			)
			// Sent notes now live in the thread; reviewed marks stay.
			updateRecord((current) => ({
				...current,
				overallNote: undefined,
				[walk.source]: { notes: {}, reviewed: current[walk.source]?.reviewed ?? {} },
			}))
			onDone()
		})

	const crumbs = useMemo((): Crumb[] => {
		const path = buildThreadPath(currentTaskItem, taskHistory ?? [])
		const thread = path.threads[path.threads.length - 1]
		const groupId = path.taskGroupId
		return [
			{
				id: "home",
				kind: "home",
				label: "Home",
				onSelect: () => (navigation ? navigation.navigate({ kind: "home" }) : onDone()),
			},
			...(groupId
				? [
						{
							id: `task:${groupId}`,
							kind: "task" as const,
							label: taskGroups?.find((group) => group.id === groupId)?.title ?? "Task",
							onSelect: () => navigateToTaskGroup(groupId),
						},
					]
				: []),
			...path.threads.slice(0, -1).map((ancestor) => ({
				id: ancestor.id,
				kind: "thread" as const,
				label: ancestor.title,
				sub: ancestor.sub,
				onSelect: () => navigation?.navigate({ kind: "thread", id: ancestor.id }),
			})),
			{ id: taskId, kind: "thread", label: thread?.title || "Thread", sub: thread?.sub, onSelect: onDone },
			{ id: `walkthrough:${taskId}`, kind: "page", label: "Walkthrough" },
		]
	}, [currentTaskItem, taskHistory, taskGroups, taskId, navigation, navigateToTaskGroup, onDone])

	const mainStops = walk?.chapters.flatMap((chapter) => chapter.stops) ?? []
	const reviewedCount = mainStops.filter((stop) => review.reviewed[stop.id]).length
	const supportHunks = walk?.support.reduce((sum, stop) => sum + stop.hunkIds.length, 0) ?? 0
	const stale = walk ? summarizeStale(store, walk.fingerprint) : { notes: 0, reviewed: 0 }
	const showMoved = moved || stale.notes + stale.reviewed > 0
	const unplaced = walk ? unplacedNotes(store, walk.fingerprint) : []
	const generatedBy = walk?.profileId ? profiles.find((p) => p.id === walk.profileId)?.name : undefined
	// Numbered up front so a collapsed chapter doesn't renumber the ones after it.
	const stopNumbers = new Map(mainStops.map((stop, index) => [stop.id, index + 1]))
	const fileCount = walk ? new Set(walk.hunks.map((h) => h.fileId)).size : 0
	const totals = (walk?.hunks ?? [])
		.filter((hunk) => !hunk.synthetic)
		.reduce(
			(sum, hunk) => {
				const counts = countChanges(hunk.patch)
				return { added: sum.added + counts.added, removed: sum.removed + counts.removed }
			},
			{ added: 0, removed: 0 },
		)
	const allCollapsed = !!walk?.chapters.length && walk.chapters.every((chapter) => folds.collapsedChapters[chapter.id])
	const complete = mainStops.length > 0 && reviewedCount === mainStops.length

	const renderStop = (stop: WalkthroughStop, numbered: boolean) => (
		<WalkthroughStopCard
			actions={actions}
			key={stop.id}
			note={review.notes[stop.id] ?? ""}
			number={numbered ? stopNumbers.get(stop.id) : undefined}
			onNote={(note) => updateStop(stop.id, { note })}
			onReviewed={(reviewed) => updateStop(stop.id, { reviewed })}
			reviewed={!!review.reviewed[stop.id]}
			stop={stop}
			walk={walk as ChangeWalkthrough}
		/>
	)

	const menuItem = (icon: string, label: string, onSelect: () => void, disabled = false) => (
		<button
			className={MENU_ITEM_CLASS}
			disabled={disabled}
			onClick={() => {
				setMenuOpen(false)
				onSelect()
			}}
			role="menuitem"
			type="button">
			<span aria-hidden className={cn(MENU_ICON_CLASS, `codicon-${icon}`)} />
			{label}
		</button>
	)

	return (
		<section className="fixed inset-0 flex flex-col overflow-hidden bg-background" data-testid="walkthrough-page">
			<div className="px-4 pt-2 pb-1">
				<div
					className="flex h-7.5 items-center gap-1 rounded-xs border border-transparent pl-0.5 pr-1 bg-(--vscode-toolbar-hoverBackground)/40"
					data-testid="walkthrough-header">
					<Breadcrumb crumbs={crumbs} />
					<div className="flex shrink-0 items-center gap-0.5">
						{!!walk?.chapters.length && (
							<HeaderIconButton
								icon={allCollapsed ? "expand-all" : "collapse-all"}
								label={allCollapsed ? "Expand all" : "Collapse all"}
								onClick={allCollapsed ? expandAll : collapseAll}
							/>
						)}
						<Popover onOpenChange={setMenuOpen} open={menuOpen}>
							<PopoverTrigger asChild>
								<HeaderIconButton icon="ellipsis" label="More actions" />
							</PopoverTrigger>
							<PopoverContent align="end" className="w-56 p-1 motion-reduce:animate-none" side="bottom">
								<div className="flex flex-col" onKeyDown={handleMenuKeyDown} role="menu">
									{menuItem("refresh", "Refresh", () => void refresh(), busy || loading)}
									{menuItem("collapse-all", "Collapse all", collapseAll, !walk?.chapters.length)}
									{menuItem("expand-all", "Expand all", expandAll, !walk?.chapters.length)}
									<div className={MENU_SEPARATOR_CLASS} role="separator" />
									{menuItem(
										"clear-all",
										"Clear notes and marks",
										() => updateRecord(() => ({})),
										!walk || (!reviewedCount && !sending.count),
									)}
									{menuItem("comment-discussion", "Back to thread", onDone)}
								</div>
							</PopoverContent>
						</Popover>
						<HeaderIconButton icon="close" label="Close walkthrough" onClick={onDone} tooltip="Back to the thread" />
					</div>
				</div>
			</div>

			<div className="min-h-0 flex-1 overflow-y-auto px-4 pt-2 pb-6 text-xs">
				<div className="flex flex-wrap items-center gap-2" data-testid="walkthrough-toolbar">
					<div
						aria-label="Scope"
						className="inline-flex h-6 items-stretch gap-px rounded-xs border border-solid border-editor-group-border p-px"
						role="group">
						{SCOPES.map((option) => (
							<Button
								aria-pressed={scope === option.scope}
								className={cn(
									"h-full rounded-[1px] px-2 py-0",
									scope !== option.scope && "text-description hover:bg-list-hover hover:text-foreground",
								)}
								disabled={generating}
								key={option.scope}
								onClick={() => setScope(option.scope)}
								size="xs"
								variant={scope === option.scope ? "default" : "ghost"}>
								{option.label}
							</Button>
						))}
					</div>
					<span className="flex-1" />
					<GenerateControl
						disabled={!walk || !walk.hunks.length || busy || moved}
						generating={generating}
						onGenerate={() => void generate()}
						onOpenProfiles={() => navigateToSettings("profiles")}
						onPickProfile={setPickedProfileId}
						profileId={profileId}
						profiles={profiles}
						regenerate={walk?.source === "generated"}
					/>
				</div>

				{error && (
					<InlineNotice
						actions={
							<LinkButton aria-label="Dismiss error" onClick={() => setError("")}>
								Dismiss
							</LinkButton>
						}
						className="mt-3"
						tone="error">
						{error}
					</InlineNotice>
				)}
				{walk && unplaced.length > 0 && (
					<InlineNotice
						actions={
							<>
								<Button
									disabled={busy}
									onClick={() => persist(recoverUnplacedNotes(store, walk.fingerprint))}
									size="xs"
									variant="secondary">
									Add to overall note
								</Button>
								<Button
									disabled={busy}
									onClick={() => persist(discardUnplacedNotes(store, walk.fingerprint))}
									size="xs"
									variant="secondary">
									Discard
								</Button>
							</>
						}
						className="mt-3"
						data-testid="walkthrough-unplaced"
						tone="warning">
						{plural(unplaced.length, "note")} from the previous layout did not fit a new stop.
					</InlineNotice>
				)}
				{walk && showMoved && (
					<InlineNotice
						actions={
							<Button disabled={busy} onClick={() => void refresh()} size="xs" variant="secondary">
								Refresh
							</Button>
						}
						className="mt-3"
						data-testid="walkthrough-moved"
						tone="warning">
						Changes moved; refresh.
						{stale.notes + stale.reviewed > 0 &&
							` ${[stale.notes && plural(stale.notes, "note"), stale.reviewed && `${stale.reviewed} reviewed`].filter(Boolean).join(" and ")} from the earlier changes will be cleared.`}
					</InlineNotice>
				)}

				{loading && !walk && (
					<div
						className="flex flex-col items-center gap-2 py-12 text-center text-description"
						data-testid="walkthrough-loading"
						role="status">
						<span aria-hidden className="codicon codicon-loading codicon-modifier-spin text-[16px]!" />
						Collecting changes…
					</div>
				)}

				{walk && walk.hunks.length > 0 && (
					<header className="mt-4">
						<h2 className="m-0 text-[15px] leading-snug font-semibold text-foreground">{walk.title}</h2>
						{walk.focus && (
							<InlineCodeProse className="mt-1 text-[12px] leading-normal text-description" text={walk.focus} />
						)}
						<div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-description">
							<span
								className={cn(
									"inline-flex h-4.5 items-center gap-1 rounded-xs border border-solid px-1.5",
									walk.source === "generated" ? "border-link/40 text-link" : "border-editor-group-border",
								)}
								data-testid="walkthrough-source"
								title={
									walk.source === "generated"
										? walk.cacheHit
											? "Grouped by idea · saved result for these changes"
											: "Grouped by idea"
										: "Grouped by the agent's turns"
								}>
								<span
									aria-hidden
									className={cn(
										"codicon text-[11px]!",
										walk.source === "generated" ? "codicon-sparkle" : "codicon-history",
									)}
								/>
								{walk.source === "generated" ? `Generated · ${generatedBy ?? "profile"}` : "From turns"}
							</span>
							<span>{plural(fileCount, "file")}</span>
							<span className="flex items-center gap-1 font-mono tabular-nums">
								<span className="text-(--vscode-gitDecoration-addedResourceForeground)">+{totals.added}</span>
								<span className="text-(--vscode-gitDecoration-deletedResourceForeground)">−{totals.removed}</span>
							</span>
						</div>
						{mainStops.length > 0 && (
							<div className="mt-3 flex items-center gap-2">
								<div
									aria-label="Stops reviewed"
									aria-valuemax={mainStops.length}
									aria-valuemin={0}
									aria-valuenow={reviewedCount}
									className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-editor-group-border"
									role="progressbar">
									<div
										className="h-full rounded-full bg-success transition-[width] motion-reduce:transition-none"
										style={{ width: `${(reviewedCount / mainStops.length) * 100}%` }}
									/>
								</div>
								<span
									className={cn(
										"shrink-0 text-[11px] tabular-nums",
										complete ? "text-success" : "text-description",
									)}
									data-testid="walkthrough-progress">
									{reviewedCount} / {mainStops.length} stops reviewed
								</span>
							</div>
						)}
					</header>
				)}

				{walk && walk.warnings.length > 0 && (
					<ul className="mt-3 mb-0 flex list-none flex-col gap-1 rounded-xs border border-solid border-editor-group-border bg-code px-2 py-1.5 text-[11px] text-description">
						{walk.warnings.map((warning) => (
							<li className="flex gap-1.5 break-words" key={warning}>
								<span aria-hidden className="codicon codicon-info mt-px text-[11px]!" />
								<span className="min-w-0">{warning}</span>
							</li>
						))}
					</ul>
				)}

				{walk && !walk.hunks.length && (
					<div
						className="flex flex-col items-center gap-1.5 py-12 text-center text-description"
						data-testid="walkthrough-empty">
						<span aria-hidden className="codicon codicon-diff text-[24px]! opacity-60" />
						<span className="text-[13px] font-medium text-foreground">No changes</span>
						<span>{EMPTY_HINT[scope]}</span>
						{scope !== "git" && (
							<LinkButton className="mt-1" onClick={() => setScope("git")}>
								Show the whole git diff
							</LinkButton>
						)}
					</div>
				)}

				{walk?.chapters.map((chapter) => {
					const open = !folds.collapsedChapters[chapter.id]
					const done = chapter.stops.filter((stop) => review.reviewed[stop.id]).length
					return (
						<section aria-label={chapter.title} className="mt-5" data-testid="walkthrough-chapter" key={chapter.id}>
							<button
								aria-controls={`walkthrough-chapter-${chapter.id}`}
								aria-expanded={open}
								className="group mb-2 flex h-5 w-full cursor-pointer items-center gap-1.5 rounded-xs border-0 bg-transparent p-0 text-left text-[11px] font-semibold uppercase tracking-wider text-description hover:text-foreground focus-visible:outline focus-visible:outline-1 focus-visible:outline-(--vscode-focusBorder)"
								onClick={() => toggleChapter(chapter.id)}
								type="button">
								<span aria-hidden className={`codicon codicon-chevron-${open ? "down" : "right"} text-[12px]!`} />
								<span className="min-w-0 truncate">{chapter.title}</span>
								<span
									className={cn(
										"shrink-0 font-normal normal-case tracking-normal tabular-nums",
										done === chapter.stops.length && done > 0 && "text-success",
									)}>
									{done}/{chapter.stops.length}
								</span>
								<span aria-hidden className="h-px flex-1 bg-editor-group-border" />
							</button>
							{open && (
								<div className="flex flex-col gap-2.5" id={`walkthrough-chapter-${chapter.id}`}>
									{chapter.stops.map((stop) => renderStop(stop, true))}
								</div>
							)}
						</section>
					)
				})}

				{walk && walk.support.length > 0 && (
					<section className="mt-5" data-testid="walkthrough-support">
						<button
							aria-expanded={folds.supportOpen}
							className="flex h-7 w-full cursor-pointer items-center gap-1.5 rounded-xs border border-dashed border-editor-group-border bg-transparent px-2 text-left text-xs text-description hover:bg-list-hover hover:text-foreground focus-visible:outline focus-visible:outline-1 focus-visible:outline-(--vscode-focusBorder)"
							onClick={() => setFolds((current) => ({ ...current, supportOpen: !current.supportOpen }))}
							type="button">
							<span
								aria-hidden
								className={`codicon codicon-chevron-${folds.supportOpen ? "down" : "right"} text-[12px]!`}
							/>
							<span className="font-semibold">Support</span>
							<span className="min-w-0 flex-1 truncate text-[11px]">{supportSummary(walk)}</span>
							<span className="shrink-0 text-[11px] tabular-nums">{plural(supportHunks, "hunk")}</span>
						</button>
						{folds.supportOpen && (
							<div className="mt-2 flex flex-col gap-2.5">
								{walk.support.map((stop) => renderStop(stop, false))}
							</div>
						)}
					</section>
				)}

				{walk && walk.hunks.length > 0 && (
					<section aria-label="Overall" className="mt-5">
						<div className="mb-2 flex h-5 items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-description">
							<span aria-hidden className="codicon codicon-comment-discussion text-[12px]!" />
							<span className="shrink-0">Overall</span>
							<span aria-hidden className="h-px flex-1 bg-editor-group-border" />
						</div>
						{overallOpen ? (
							<NoteEditor
								label="Note on the whole change"
								onChange={(value) => updateRecord((current) => ({ ...current, overallNote: value }))}
								onDone={() => setOverallOpen(false)}
								placeholder="Anything about the whole change…"
								value={overallNote}
							/>
						) : overallNote.trim() ? (
							<NoteQuote label="Overall" note={overallNote} onEdit={() => setOverallOpen(true)} />
						) : (
							<Button className="h-6 gap-1 px-2" onClick={() => setOverallOpen(true)} size="xs" variant="secondary">
								<span aria-hidden className="codicon codicon-comment text-[12px]!" />
								Add a note on the whole change
							</Button>
						)}
					</section>
				)}
			</div>

			<div
				className="flex items-center gap-2 border-t border-solid border-x-0 border-b-0 border-editor-group-border bg-background px-4 py-2"
				data-testid="walkthrough-send-bar">
				<span
					className={cn(
						"flex min-w-0 items-center gap-1.5 text-xs",
						sending.count ? "text-foreground" : "text-description",
					)}>
					<span aria-hidden className="codicon codicon-comment text-[13px]!" />
					{sending.count ? plural(sending.count, "note") : "No notes yet"}
				</span>
				<span className="flex-1" />
				<Button
					className="h-6 gap-1 px-2.5"
					disabled={!sending.count || busy || generating || moved}
					onClick={() => void send()}
					size="xs"
					title="Sends every note to the thread as one message">
					<span aria-hidden className="codicon codicon-send text-[12px]!" />
					Send to thread
				</Button>
			</div>
		</section>
	)
}

const EMPTY_WALK: ChangeWalkthrough = {
	version: 1,
	taskId: "",
	scope: "thread",
	fingerprint: "",
	source: "fallback",
	title: "",
	focus: "",
	chapters: [],
	support: [],
	hunks: [],
	warnings: [],
}
