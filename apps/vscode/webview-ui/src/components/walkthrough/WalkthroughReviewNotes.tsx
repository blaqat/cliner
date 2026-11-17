import type { ChangeWalkthrough, WalkthroughReviewKind, WalkthroughReviewResponse } from "@shared/Walkthrough"
import { useState } from "react"
import { handleMenuKeyDown } from "@/components/chat/composer/menuKeyboard"
import { LinkButton } from "@/components/common/LinkButton"
import { MENU_HEADING_CLASS, MENU_ICON_CLASS, MENU_ITEM_CLASS, MENU_SEPARATOR_CLASS } from "@/components/common/menuStyles"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import {
	describeKinds,
	KIND_ORDER,
	type PlacedReviewNote,
	REVIEW_KINDS,
	type ReviewFilter,
	type ReviewGroup,
	reviewLineLabel,
	shownByFilter,
	splitGroup,
} from "./reviewNotes"
import { InlineCodeProse, NoteEditor } from "./WalkthroughNote"

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`

/** Cline's notes keep a dashed grey edge: never the reviewer's solid blue one, nor the Why notes' solid grey. */
export const CLINE_EDGE_CLASS = "border-0 border-l-2 border-dashed border-description/70 bg-code"

/** A quiet text action inside a note (Fix, Reply, Dismiss, Undo). */
const ACTION_CLASS =
	"inline-flex h-5.5 shrink-0 cursor-pointer items-center gap-1 rounded-xs border-0 bg-transparent px-1.5 font-[inherit] text-[11px] text-description hover:bg-list-hover hover:text-foreground focus-visible:outline focus-visible:outline-1 focus-visible:outline-(--vscode-focusBorder)"

export function KindIcon({ kind, className }: { kind: WalkthroughReviewKind; className?: string }) {
	const meta = REVIEW_KINDS[kind]
	return <span aria-hidden className={cn("codicon shrink-0 text-[12px]!", `codicon-${meta.icon}`, meta.tone, className)} />
}

/** Severity is only marked when it's high, and quietly. */
export function HighMark() {
	return (
		<span
			className="shrink-0 rounded-xs border border-solid border-warning/45 px-1 text-[10px] leading-3.5 font-semibold text-warning"
			data-testid="review-high">
			High
		</span>
	)
}

/** "✦ Cline": who wrote the note. */
function ClineLabel() {
	return (
		<span className="inline-flex shrink-0 items-center gap-1 font-medium text-foreground">
			<span aria-hidden className="codicon codicon-sparkle text-[11px]!" />
			Cline
		</span>
	)
}

export interface ReviewNoteHandlers {
	response: (id: string) => WalkthroughReviewResponse | undefined
	respond: (id: string, change: Partial<WalkthroughReviewResponse>) => void
	/** The note whose reply box is open (one at a time). */
	replying?: string
	onReplying: (id: string | undefined) => void
}

/**
 * One of Cline's notes: who, kind, title and text, then Fix, Reply and Dismiss. Fix and a reply go
 * with Send; a dismissed note folds to one line with Undo. Cline wrote it, so it isn't edited.
 */
export function ReviewNoteCard({
	walk,
	placed,
	handlers,
	location,
	className,
}: {
	walk: ChangeWalkthrough
	placed: PlacedReviewNote
	handlers: ReviewNoteHandlers
	/** Shown at the header's end: "lines 48–49", "line not found"… */
	location?: string
	className?: string
}) {
	const { note } = placed
	const response = handlers.response(note.id) ?? {}
	const replying = handlers.replying === note.id
	const reply = response.reply ?? ""
	const kind = REVIEW_KINDS[note.kind]
	const where = location ?? (placed.lineLost ? "line not found" : reviewLineLabel(walk, placed))
	if (response.dismissed)
		return (
			<div
				className={cn(
					"flex min-w-0 items-center gap-1.5 rounded-xs border border-dashed border-editor-group-border px-2 py-0.5 font-sans text-[11px] text-description",
					className,
				)}
				data-review-note={note.id}
				data-testid="review-note-dismissed">
				<span aria-hidden className="codicon codicon-sparkle text-[11px]! opacity-70" />
				<KindIcon className="opacity-70" kind={note.kind} />
				<span className="min-w-0 flex-1 truncate">{note.title}</span>
				<span className="shrink-0">Dismissed</span>
				<LinkButton className="shrink-0 text-[11px]" onClick={() => handlers.respond(note.id, { dismissed: false })}>
					Undo
				</LinkButton>
			</div>
		)
	return (
		<div
			aria-label={`Cline · ${kind.label}: ${note.title}`}
			className={cn(CLINE_EDGE_CLASS, "px-2 pt-1 pb-1.5 font-sans text-xs leading-normal text-foreground", className)}
			data-kind={note.kind}
			data-review-note={note.id}
			data-testid="review-note"
			role="group">
			<div className="flex min-w-0 items-center gap-1 text-[11px] text-description">
				<ClineLabel />
				<span aria-hidden className="opacity-60">
					·
				</span>
				<KindIcon kind={note.kind} />
				<span className="shrink-0">{kind.label}</span>
				{note.severity === "high" && <HighMark />}
				<span className="flex-1" />
				{where && (
					<span
						className="shrink-0 truncate text-[10.5px]"
						title={placed.lineLost ? "The line Cline pointed at isn't in this diff" : undefined}>
						{where}
					</span>
				)}
			</div>
			<div className="mt-0.5 font-semibold">{note.title}</div>
			<InlineCodeProse className="text-description" text={note.text} />
			{reply.trim() && !replying && (
				<button
					className="mt-1.5 ml-3 block w-[calc(100%-0.75rem)] cursor-pointer rounded-xs border-0 border-l-2 border-solid border-link bg-background px-2 py-1 text-left font-[inherit] text-xs text-foreground hover:bg-list-hover"
					data-testid="review-reply"
					onClick={() => handlers.onReplying(note.id)}
					title="Edit reply"
					type="button">
					<span className="mb-0.5 flex items-center gap-1 text-[10px] font-medium uppercase tracking-wider text-link">
						<span aria-hidden className="codicon codicon-reply text-[11px]!" />
						You · reply
					</span>
					<span className="block whitespace-pre-wrap break-words">{reply.trim()}</span>
				</button>
			)}
			{replying && (
				<NoteEditor
					className="mt-1.5 ml-3"
					label={`Reply to ${note.title}`}
					onChange={(value) => handlers.respond(note.id, { reply: value })}
					onDone={() => handlers.onReplying(undefined)}
					placeholder="Reply to Cline… (goes with Send)"
					value={reply}
				/>
			)}
			<div className="mt-1 -ml-1.5 flex flex-wrap items-center gap-0.5">
				{note.kind !== "nice" && (
					<button
						aria-pressed={!!response.fix}
						className={cn(
							ACTION_CLASS,
							response.fix &&
								"bg-button-secondary-background text-button-secondary-foreground hover:bg-button-secondary-background-hover hover:text-button-secondary-foreground",
						)}
						onClick={() => handlers.respond(note.id, { fix: !response.fix })}
						title={
							response.fix ? "Goes with Send as a fix. Click to take it out" : "Ask Cline to fix this when you Send"
						}
						type="button">
						<span
							aria-hidden
							className={cn("codicon text-[12px]!", response.fix ? "codicon-check" : "codicon-tools")}
						/>
						{response.fix ? "Fix in Send" : "Fix"}
					</button>
				)}
				<button
					aria-expanded={replying}
					className={ACTION_CLASS}
					onClick={() => handlers.onReplying(replying ? undefined : note.id)}
					title="Reply under Cline's note; it goes with Send"
					type="button">
					<span aria-hidden className="codicon codicon-reply text-[12px]!" />
					{reply.trim() ? "Edit reply" : "Reply"}
				</button>
				<button
					className={ACTION_CLASS}
					onClick={() => {
						if (replying) handlers.onReplying(undefined)
						handlers.respond(note.id, { dismissed: true })
					}}
					title="Fold it away; dismissed notes stay out of Send"
					type="button">
					<span aria-hidden className="codicon codicon-close text-[12px]!" />
					Dismiss
				</button>
			</div>
		</div>
	)
}

/** How a note's row says it's been answered. */
function rowStatus(response: WalkthroughReviewResponse | undefined): string | undefined {
	if (!response) return undefined
	if (response.dismissed) return "Dismissed"
	const parts = [response.fix && "Fix", response.reply?.trim() && "Reply"].filter(Boolean)
	return parts.length ? `${parts.join(" + ")} in Send` : undefined
}

export interface ReviewPanelProps {
	walk: ChangeWalkthrough
	groups: ReviewGroup[]
	/** Every placed note, before the filter (for counts). */
	all: PlacedReviewNote[]
	filter: ReviewFilter
	onFilter: (filter: ReviewFilter) => void
	handlers: ReviewNoteHandlers
	/** The note a gutter marker last opened: highlighted (and shown) in its group. */
	activeId?: string
	/** Scrolls to the note's line or stop and opens it there. */
	onJump: (placed: PlacedReviewNote) => void
}

/**
 * Cline's review at the top of the page: the summary, a kind filter, then every note grouped by
 * stop (whole-change notes first). Each group shows its top three, "+N more", and folds Nice notes
 * into one line. Jump links scroll to the line or stop and open the note there.
 */
export function ReviewPanel({ walk, groups, all, filter, onFilter, handlers, activeId, onJump }: ReviewPanelProps) {
	const [expanded, setExpanded] = useState<Record<string, boolean>>({})
	const [moreOpen, setMoreOpen] = useState<Record<string, boolean>>({})
	const [niceOpen, setNiceOpen] = useState<Record<string, boolean>>({})
	const summary = walk.review?.summary?.trim()
	const kinds = KIND_ORDER.filter((kind) => all.some((p) => p.note.kind === kind))
	const shown = all.filter((p) => shownByFilter(filter, p))
	const filtered = KIND_ORDER.some((kind) => filter.hidden[kind])

	if (filter.all)
		return (
			<div
				className="mt-3 flex items-center gap-1.5 rounded-xs border border-dashed border-editor-group-border px-2 py-1 text-[11px] text-description"
				data-testid="review-hidden">
				<span aria-hidden className="codicon codicon-eye-closed text-[12px]!" />
				<span className="min-w-0 flex-1">{plural(all.length, "note")} from Cline are hidden.</span>
				<LinkButton className="shrink-0 text-[11px]" onClick={() => onFilter({ ...filter, all: false })}>
					Show them
				</LinkButton>
			</div>
		)

	const row = (placed: PlacedReviewNote) => {
		const { note } = placed
		const open = !!expanded[note.id]
		const response = handlers.response(note.id)
		const status = rowStatus(response)
		const line = reviewLineLabel(walk, placed)
		const jump = line ? `${line} ↓` : placed.stopId && !placed.lineLost ? "stop ↓" : undefined
		return (
			<div data-review-row={note.id} key={note.id}>
				<div
					aria-current={activeId === note.id || undefined}
					className={cn(
						"flex h-6 min-w-0 items-center gap-1 rounded-xs pr-1 hover:bg-list-hover",
						activeId === note.id && "bg-list-hover",
						response?.dismissed && "opacity-60",
					)}
					data-testid="review-row">
					<button
						aria-expanded={open}
						className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-1.5 border-0 bg-transparent py-0 pr-1 pl-1 text-left font-[inherit] text-xs text-foreground focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-(--vscode-focusBorder)"
						onClick={() => setExpanded((current) => ({ ...current, [note.id]: !open }))}
						type="button">
						<span
							aria-hidden
							className={`codicon codicon-chevron-${open ? "down" : "right"} text-[11px]! text-description`}
						/>
						<KindIcon kind={note.kind} />
						<span className={cn("min-w-0 truncate", response?.dismissed && "line-through")}>{note.title}</span>
						{note.severity === "high" && <HighMark />}
						{status && <span className="shrink-0 text-[10.5px] text-description">{status}</span>}
					</button>
					{placed.lineLost ? (
						<span
							className="shrink-0 text-[10.5px] text-description"
							title="The line Cline pointed at isn't in this diff; the note sits on its stop or the whole change">
							line not found
						</span>
					) : (
						jump && (
							<LinkButton
								aria-label={`Go to ${line ?? "stop"}: ${note.title}`}
								className="shrink-0 text-[10.5px]"
								onClick={() => onJump(placed)}>
								{jump}
							</LinkButton>
						)
					)}
				</div>
				{open && <ReviewNoteCard className="mt-0.5 mb-1 ml-5" handlers={handlers} placed={placed} walk={walk} />}
			</div>
		)
	}

	return (
		<section
			aria-label="Cline's review"
			className={cn(CLINE_EDGE_CLASS, "mt-3 rounded-r-xs px-2.5 pt-1.5 pb-2 text-xs")}
			data-testid="review-panel">
			<div className="flex min-w-0 items-center gap-1.5 text-[11px] text-description">
				<span aria-hidden className="codicon codicon-sparkle text-[12px]!" />
				<span className="font-semibold text-foreground">Cline's review</span>
				{all.length > 0 && <span className="tabular-nums">{all.length}</span>}
			</div>
			{summary && <InlineCodeProse className="mt-1 text-xs leading-normal text-foreground" text={summary} />}
			{all.length === 0 && (
				<div className="mt-1 flex items-center gap-1.5 text-description" data-testid="review-empty">
					<span aria-hidden className="codicon codicon-check text-[12px]! text-success" />
					Cline found nothing to flag in this change.
				</div>
			)}
			{kinds.length > 1 && (
				<div aria-label="Filter Cline's notes by kind" className="mt-1.5 flex flex-wrap gap-1" role="group">
					<FilterChip on={!filtered} onClick={() => onFilter({ ...filter, hidden: {} })}>
						All {all.length}
					</FilterChip>
					{kinds.map((kind) => (
						<FilterChip
							key={kind}
							on={!filter.hidden[kind]}
							onClick={() => onFilter({ ...filter, hidden: { ...filter.hidden, [kind]: !filter.hidden[kind] } })}>
							<KindIcon kind={kind} />
							{REVIEW_KINDS[kind].label} {all.filter((p) => p.note.kind === kind).length}
						</FilterChip>
					))}
				</div>
			)}
			{all.length > 0 && shown.length === 0 && (
				<div className="mt-2 text-description" data-testid="review-filtered-empty">
					All {plural(all.length, "note")} are hidden by the filter.{" "}
					<LinkButton className="text-xs" onClick={() => onFilter({ ...filter, hidden: {} })}>
						Clear filter
					</LinkButton>
				</div>
			)}
			{groups.map((group) => {
				const visible = group.notes.filter((p) => shownByFilter(filter, p))
				if (!visible.length) return null
				const { top, more, nice } = splitGroup(visible)
				const showMore = moreOpen[group.key] || more.some((p) => p.note.id === activeId)
				const showNice = niceOpen[group.key] || nice.some((p) => p.note.id === activeId)
				return (
					<div className="mt-2" data-group={group.key} data-testid="review-group" key={group.key}>
						<div className="mb-0.5 truncate px-1 text-[10px] font-medium uppercase tracking-wider text-description">
							{group.stop ? `${group.number ? `${group.number} · ` : ""}${group.stop.title}` : "The whole change"}
						</div>
						{top.map(row)}
						{more.length > 0 &&
							(showMore ? (
								more.map(row)
							) : (
								<LinkButton
									className="ml-1 h-6 text-[11px]"
									data-testid="review-more"
									onClick={() => setMoreOpen((current) => ({ ...current, [group.key]: true }))}>
									+{more.length} more · {describeKinds(more)}
								</LinkButton>
							))}
						{nice.length > 0 && (
							<>
								<button
									aria-expanded={showNice}
									className="flex h-6 w-full cursor-pointer items-center gap-1.5 rounded-xs border-0 bg-transparent px-1 text-left font-[inherit] text-xs text-description hover:bg-list-hover hover:text-foreground"
									data-testid="review-nice"
									onClick={() => setNiceOpen((current) => ({ ...current, [group.key]: !showNice }))}
									type="button">
									<span
										aria-hidden
										className={`codicon codicon-chevron-${showNice ? "down" : "right"} text-[11px]!`}
									/>
									<KindIcon kind="nice" />
									{nice.length === 1 ? "1 nice thing" : `${nice.length} nice things`}
								</button>
								{showNice && <div className="pl-3">{nice.map(row)}</div>}
							</>
						)}
					</div>
				)
			})}
		</section>
	)
}

function FilterChip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
	return (
		<button
			aria-pressed={on}
			className={cn(
				"inline-flex h-5 cursor-pointer items-center gap-1 rounded-xs border border-solid px-1.5 font-[inherit] text-[11px] tabular-nums focus-visible:outline focus-visible:outline-1 focus-visible:outline-(--vscode-focusBorder)",
				on
					? "border-editor-group-border bg-list-hover text-foreground"
					: "border-editor-group-border/60 bg-transparent text-description hover:text-foreground",
			)}
			onClick={onClick}
			type="button">
			{children}
		</button>
	)
}

/**
 * `✦ 8 from Cline · 1 high ▾` in the page header: a kind filter and a way to hide all of Cline's
 * notes, markers and panel alike. One short menu, no inner scrolling.
 */
export function ReviewChip({
	all,
	filter,
	onFilter,
	highOpen,
}: {
	all: PlacedReviewNote[]
	filter: ReviewFilter
	onFilter: (filter: ReviewFilter) => void
	/** High-severity notes not yet dismissed. */
	highOpen: number
}) {
	const [open, setOpen] = useState(false)
	const kinds = KIND_ORDER.filter((kind) => all.some((p) => p.note.kind === kind))
	const shown = all.filter((p) => shownByFilter(filter, p)).length
	const label = filter.all
		? "Cline's notes hidden"
		: shown === all.length
			? `${all.length} from Cline`
			: `${shown} of ${all.length} from Cline`
	return (
		<Popover onOpenChange={setOpen} open={open}>
			<PopoverTrigger asChild>
				<button
					aria-label={`${label}. Filter or hide Cline's notes`}
					className="inline-flex h-4.5 cursor-pointer items-center gap-1 rounded-xs border border-solid border-editor-group-border bg-transparent px-1.5 font-[inherit] text-[11px] text-description hover:bg-list-hover hover:text-foreground data-[state=open]:bg-list-hover"
					data-testid="review-chip"
					type="button">
					<span
						aria-hidden
						className={cn("codicon text-[11px]!", filter.all ? "codicon-eye-closed" : "codicon-sparkle")}
					/>
					{label}
					{!filter.all && highOpen > 0 && <span className="text-warning">· {highOpen} high</span>}
					<span aria-hidden className="codicon codicon-chevron-down text-[11px]!" />
				</button>
			</PopoverTrigger>
			<PopoverContent align="start" className="menu-rise w-56 p-1" onKeyDown={handleMenuKeyDown} side="bottom">
				<div className={MENU_HEADING_CLASS}>Show Cline's notes</div>
				<div className="flex flex-col" role="menu">
					{kinds.map((kind) => (
						<button
							aria-checked={!filter.hidden[kind] && !filter.all}
							className={MENU_ITEM_CLASS}
							disabled={filter.all}
							key={kind}
							onClick={() => onFilter({ ...filter, hidden: { ...filter.hidden, [kind]: !filter.hidden[kind] } })}
							role="menuitemcheckbox"
							type="button">
							<Box on={!filter.hidden[kind] && !filter.all} />
							<KindIcon kind={kind} />
							<span className="min-w-0 flex-1 truncate">{REVIEW_KINDS[kind].label}</span>
							<span className="shrink-0 text-[11px] text-description tabular-nums">
								{all.filter((p) => p.note.kind === kind).length}
							</span>
						</button>
					))}
					{kinds.length > 0 && <div className={MENU_SEPARATOR_CLASS} role="separator" />}
					<button
						className={MENU_ITEM_CLASS}
						onClick={() => {
							onFilter({ ...filter, all: !filter.all })
							setOpen(false)
						}}
						role="menuitem"
						type="button">
						<span aria-hidden className={cn(MENU_ICON_CLASS, filter.all ? "codicon-eye" : "codicon-eye-closed")} />
						{filter.all ? "Show Cline's notes" : "Hide all of Cline's notes"}
					</button>
				</div>
			</PopoverContent>
		</Popover>
	)
}

/** A menu checkbox drawn in the menu's own colors. */
export function Box({ on }: { on: boolean }) {
	return (
		<span
			aria-hidden
			className="flex size-3 shrink-0 items-center justify-center rounded-[2px] border border-solid border-menu-foreground/50">
			{on && <span className="codicon codicon-check text-[10px]!" />}
		</span>
	)
}
