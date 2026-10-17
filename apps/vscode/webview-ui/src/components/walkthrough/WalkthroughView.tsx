import { StringRequest } from "@shared/proto/cline/common"
import type { ChangeWalkthrough, WalkthroughRequest, WalkthroughScope, WalkthroughStop } from "@shared/Walkthrough"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { buildThreadPath } from "@/components/chat/chat-view/utils/threadUtils"
import { Breadcrumb, type Crumb } from "@/components/chat/task-header/Breadcrumb"
import { HeaderIconButton } from "@/components/chat/task-header/HeaderIconButton"
import { MENU_ITEM_CLASS } from "@/components/common/menuStyles"
import { useNavigationHistory } from "@/components/navigation/NavigationHistoryContext"
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
import { InlineCodeProse, LINK_BUTTON_CLASS, NoteEditor, type RevertTarget, WalkthroughStopCard } from "./WalkthroughStopCard"
import { supportSummary } from "./walkthroughUtils"

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

const ChapterHeader = ({ title }: { title: string }) => (
	<div className="mt-4 mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-description">
		<span className="shrink-0">{title}</span>
		<span className="h-px flex-1 bg-editor-group-border" />
	</div>
)

/**
 * `Task › Thread › Walkthrough`: the thread's changes as one long scroll of
 * chapters and stops. Free by default (grouped by turn); Generate is the only
 * AI-cost action and runs only when clicked. Notes go to the thread as one message.
 */
export default function WalkthroughView({ taskId, onDone }: { taskId: string; onDone: () => void }) {
	const {
		apiConfigProfiles,
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
	const [supportOpen, setSupportOpen] = useState(false)
	const [overallOpen, setOverallOpen] = useState(false)
	const [menuOpen, setMenuOpen] = useState(false)
	const sequence = useRef(0)
	// Generate finishes long after it starts; it must merge into the latest notes, not a stale render's.
	const storeRef = useRef(store)
	storeRef.current = store

	const profiles = apiConfigProfiles ?? []
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

	const input = walk ? { taskId, scope, fingerprint: walk.fingerprint } : undefined
	const actions = {
		busy: busy || generating || moved,
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
	let stopNumber = 0

	const renderStop = (stop: WalkthroughStop, numbered: boolean) => (
		<WalkthroughStopCard
			actions={actions}
			key={stop.id}
			note={review.notes[stop.id] ?? ""}
			number={numbered ? ++stopNumber : undefined}
			onNote={(note) => updateStop(stop.id, { note })}
			onReviewed={(reviewed) => updateStop(stop.id, { reviewed })}
			reviewed={!!review.reviewed[stop.id]}
			stop={stop}
			walk={walk as ChangeWalkthrough}
		/>
	)

	return (
		<section className="fixed inset-0 flex flex-col overflow-hidden bg-background" data-testid="walkthrough-page">
			<div className="px-4 pt-2 pb-1">
				<div
					className="flex h-7.5 items-center gap-1 rounded-xs border border-transparent pl-0.5 pr-1 bg-(--vscode-toolbar-hoverBackground)/40"
					data-testid="walkthrough-header">
					<Breadcrumb crumbs={crumbs} />
					<div className="flex shrink-0 items-center gap-0.5">
						<Popover onOpenChange={setMenuOpen} open={menuOpen}>
							<PopoverTrigger asChild>
								<HeaderIconButton icon="ellipsis" label="More actions" />
							</PopoverTrigger>
							<PopoverContent align="end" className="w-56 p-1 motion-reduce:animate-none" side="bottom">
								<div className="flex flex-col" role="menu">
									<button
										className={MENU_ITEM_CLASS}
										disabled={busy || loading}
										onClick={() => {
											setMenuOpen(false)
											void refresh()
										}}
										role="menuitem"
										type="button">
										<span aria-hidden className="codicon codicon-refresh text-[13px]" />
										Refresh
									</button>
									<button
										className={MENU_ITEM_CLASS}
										disabled={!walk || (!reviewedCount && !sending.count)}
										onClick={() => {
											setMenuOpen(false)
											updateRecord(() => ({}))
										}}
										role="menuitem"
										type="button">
										<span aria-hidden className="codicon codicon-clear-all text-[13px]" />
										Clear notes and marks
									</button>
									<button
										className={MENU_ITEM_CLASS}
										onClick={() => {
											setMenuOpen(false)
											onDone()
										}}
										role="menuitem"
										type="button">
										<span aria-hidden className="codicon codicon-comment-discussion text-[13px]" />
										Back to thread
									</button>
								</div>
							</PopoverContent>
						</Popover>
						<HeaderIconButton icon="close" label="Close walkthrough" onClick={onDone} tooltip="Back to the thread" />
					</div>
				</div>
			</div>

			<div className="min-h-0 flex-1 overflow-y-auto px-4 pt-1 pb-4 text-xs">
				<div className="flex flex-wrap items-start gap-2">
					<div aria-label="Scope" className="flex items-center gap-1" role="group">
						{SCOPES.map((option) => (
							<button
								aria-pressed={scope === option.scope}
								className={cn(
									"cursor-pointer rounded-sm border border-solid px-2 py-0.5 text-xs",
									scope === option.scope
										? "border-(--vscode-focusBorder) bg-(--vscode-list-activeSelectionBackground) text-(--vscode-list-activeSelectionForeground)"
										: "border-(--vscode-panel-border) bg-transparent text-foreground",
								)}
								disabled={generating}
								key={option.scope}
								onClick={() => setScope(option.scope)}
								type="button">
								{option.label}
							</button>
						))}
					</div>
					<span className="flex-1" />
					<GenerateControl
						disabled={!walk || !walk.hunks.length || busy || moved}
						generating={generating}
						onGenerate={() => void generate()}
						onOpenProfiles={() => navigateToSettings("api-config")}
						onPickProfile={setPickedProfileId}
						profileId={profileId}
						profiles={profiles}
						regenerate={walk?.source === "generated"}
					/>
				</div>

				{generating && (
					<div className="mt-2 flex items-center gap-1.5 text-description" role="status">
						<span aria-hidden className="codicon codicon-loading codicon-modifier-spin text-[12px]!" />
						Generating with {profiles.find((p) => p.id === profileId)?.name ?? "the chosen profile"}…
					</div>
				)}
				{loading && !walk && (
					<div className="mt-3 flex items-center gap-1.5 text-description" role="status">
						<span aria-hidden className="codicon codicon-loading codicon-modifier-spin text-[12px]!" />
						Collecting changes…
					</div>
				)}
				{error && (
					<div
						className="mt-2 flex items-start gap-1.5 rounded-xs border border-solid border-(--vscode-inputValidation-errorBorder) bg-input-error-background px-2 py-1.5 text-input-error-foreground"
						role="alert">
						<span aria-hidden className="codicon codicon-error mt-px text-[12px]!" />
						<span className="min-w-0 flex-1 break-words">{error}</span>
						<button
							aria-label="Dismiss error"
							className={LINK_BUTTON_CLASS}
							onClick={() => setError("")}
							type="button">
							Dismiss
						</button>
					</div>
				)}
				{walk && unplaced.length > 0 && (
					<div
						className="mt-2 flex flex-wrap items-center gap-1.5 rounded-xs border border-solid border-(--vscode-inputValidation-warningBorder) bg-input-warning-background px-2 py-1.5 text-input-warning-foreground"
						data-testid="walkthrough-unplaced"
						role="status">
						<span aria-hidden className="codicon codicon-warning text-[12px]!" />
						<span className="min-w-0 flex-1">
							{plural(unplaced.length, "note")} from the previous layout did not fit a new stop.
						</span>
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
					</div>
				)}
				{walk && showMoved && (
					<div
						className="mt-2 flex flex-wrap items-center gap-1.5 rounded-xs border border-solid border-(--vscode-inputValidation-warningBorder) bg-input-warning-background px-2 py-1.5 text-input-warning-foreground"
						data-testid="walkthrough-moved"
						role="status">
						<span aria-hidden className="codicon codicon-warning text-[12px]!" />
						<span className="min-w-0 flex-1">
							Changes moved; refresh.
							{stale.notes + stale.reviewed > 0 &&
								` ${[stale.notes && plural(stale.notes, "note"), stale.reviewed && `${stale.reviewed} reviewed`].filter(Boolean).join(" and ")} from the earlier changes will be cleared.`}
						</span>
						<Button disabled={busy} onClick={() => void refresh()} size="xs" variant="secondary">
							Refresh
						</Button>
					</div>
				)}

				{walk && (
					<>
						<div className="mt-3">
							<h2 className="m-0 text-[14px] font-semibold">{walk.title}</h2>
							{walk.focus && <InlineCodeProse className="mt-1 text-description" text={walk.focus} />}
							<div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-description">
								<span
									className="rounded-xs border border-solid border-(--vscode-panel-border) px-1.5"
									data-testid="walkthrough-source"
									title={
										walk.source === "generated"
											? "Grouped by idea from one call to the chosen profile"
											: "Free: grouped by the agent's turns, with each turn's message as the explanation"
									}>
									{walk.source === "generated"
										? `Generated · ${generatedBy ?? "profile"}${walk.cacheHit ? " · cached" : ""}`
										: "From turns"}
								</span>
								<span>{plural(new Set(walk.hunks.map((h) => h.fileId)).size, "file")}</span>
							</div>
							{mainStops.length > 0 && (
								<>
									<div
										aria-label="Stops reviewed"
										aria-valuemax={mainStops.length}
										aria-valuemin={0}
										aria-valuenow={reviewedCount}
										className="mt-2 h-1 overflow-hidden rounded-full bg-editor-group-border"
										role="progressbar">
										<div
											className="h-full bg-success transition-[width] motion-reduce:transition-none"
											style={{ width: `${(reviewedCount / mainStops.length) * 100}%` }}
										/>
									</div>
									<div className="mt-1 text-[11px] text-description" data-testid="walkthrough-progress">
										{reviewedCount} / {mainStops.length} stops reviewed
									</div>
								</>
							)}
						</div>

						{walk.warnings.length > 0 && (
							<ul className="mt-2 mb-0 list-none rounded-xs border border-solid border-(--vscode-panel-border) bg-code px-2 py-1.5 text-[11px] text-description">
								{walk.warnings.map((warning) => (
									<li className="flex gap-1.5 break-words" key={warning}>
										<span aria-hidden className="codicon codicon-info mt-px text-[11px]!" />
										<span className="min-w-0">{warning}</span>
									</li>
								))}
							</ul>
						)}

						{!walk.hunks.length && <p className="mt-4 text-description">No changes in this scope.</p>}

						{walk.chapters.map((chapter) => (
							<section aria-label={chapter.title} key={chapter.id}>
								<ChapterHeader title={chapter.title} />
								<div className="flex flex-col gap-2">{chapter.stops.map((stop) => renderStop(stop, true))}</div>
							</section>
						))}

						{walk.support.length > 0 && (
							<section className="mt-4" data-testid="walkthrough-support">
								<button
									aria-expanded={supportOpen}
									className="flex w-full cursor-pointer items-center gap-1.5 rounded-xs border border-solid border-editor-group-border bg-transparent px-2.5 py-1.5 text-left text-xs text-foreground opacity-80 hover:opacity-100"
									onClick={() => setSupportOpen(!supportOpen)}
									type="button">
									<span className="font-semibold">Support</span>
									<span className="min-w-0 flex-1 truncate text-[11px] text-description">
										{supportSummary(walk)}
									</span>
									<span className="shrink-0 text-[11px] text-description">{plural(supportHunks, "hunk")}</span>
									<span
										aria-hidden
										className={`codicon codicon-chevron-${supportOpen ? "down" : "right"} text-[12px]! text-description`}
									/>
								</button>
								{supportOpen && (
									<div className="mt-2 flex flex-col gap-2">
										{walk.support.map((stop) => renderStop(stop, false))}
									</div>
								)}
							</section>
						)}

						{walk.hunks.length > 0 && (
							<section aria-label="Overall">
								<ChapterHeader title="Overall" />
								{overallOpen ? (
									<NoteEditor
										label="Note on the whole change"
										onChange={(value) => updateRecord((current) => ({ ...current, overallNote: value }))}
										onDone={() => setOverallOpen(false)}
										placeholder="Anything about the whole change…"
										value={overallNote}
									/>
								) : overallNote.trim() ? (
									<div className="rounded-xs border-l-2 border-solid border-y-0 border-r-0 border-(--vscode-textLink-foreground) bg-code px-2 py-1">
										<span className="font-semibold text-link">Overall</span> ·{" "}
										<span className="whitespace-pre-wrap">{overallNote}</span>{" "}
										<button className={LINK_BUTTON_CLASS} onClick={() => setOverallOpen(true)} type="button">
											edit
										</button>
									</div>
								) : (
									<button
										className="inline-flex cursor-pointer items-center gap-1 rounded-xs border border-solid border-(--vscode-panel-border) bg-transparent px-1.5 py-0.5 text-[11px] text-foreground hover:bg-list-hover"
										onClick={() => setOverallOpen(true)}
										type="button">
										✎ Add a note on the whole change
									</button>
								)}
							</section>
						)}
					</>
				)}
			</div>

			<div
				className="flex items-center gap-2 border-t border-solid border-x-0 border-b-0 border-editor-group-border px-4 py-2"
				data-testid="walkthrough-send-bar">
				<span className="text-xs text-description">{sending.count ? plural(sending.count, "note") : "No notes yet"}</span>
				<span className="flex-1" />
				<Button disabled={!sending.count || busy || generating || moved} onClick={() => void send()} size="xs">
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
