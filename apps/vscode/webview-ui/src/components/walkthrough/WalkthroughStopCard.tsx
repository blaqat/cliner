import type { ChangeWalkthrough, WalkthroughAnnotation, WalkthroughHunk, WalkthroughStop } from "@shared/Walkthrough"
import { useState } from "react"
import { HeaderIconButton } from "@/components/chat/task-header/HeaderIconButton"
import { InlineNotice } from "@/components/common/InlineNotice"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { type LineNotes, WalkthroughDiff } from "./WalkthroughDiff"
import { InlineCodeProse, NoteEditor, NoteQuote } from "./WalkthroughNote"
import { countChanges, type StopFile, stopFiles, syntheticReason } from "./walkthroughUtils"

export { InlineCodeProse, NoteEditor, NoteQuote, QUICK_NOTES } from "./WalkthroughNote"

export interface RevertTarget {
	fileId: string
	hunkId?: string
}

export interface StopActions {
	busy: boolean
	openDiff: (fileId: string) => void
	revert: (target: RevertTarget) => Promise<boolean>
	/** Hunk folding lives on the page so Collapse all / Expand all reach every hunk. */
	hunkOpen: (hunk: WalkthroughHunk) => boolean
	toggleHunk: (hunk: WalkthroughHunk) => void
	/** Notes inside this hunk's diff, above the lines they explain. */
	annotations: (hunk: WalkthroughHunk) => WalkthroughAnnotation[]
	/** The reviewer's notes on this hunk's lines. */
	lineNotes: (hunk: WalkthroughHunk) => LineNotes
}

/** A compact codicon action inside file and hunk headers. */
const ROW_ICON_CLASS = "size-5 [&>.codicon]:text-[13px]!"

/** "+3 −1" in the git decoration colors. */
function ChangeCounts({ added, removed }: { added: number; removed: number }) {
	return (
		<span className="flex shrink-0 items-center gap-1 font-mono text-[11px] tabular-nums">
			<span className="text-(--vscode-gitDecoration-addedResourceForeground)">+{added}</span>
			<span className="text-(--vscode-gitDecoration-deletedResourceForeground)">−{removed}</span>
		</span>
	)
}

function HunkBlock({
	hunk,
	actions,
	external,
	onRevert,
}: {
	hunk: WalkthroughHunk
	actions: StopActions
	/** The changes aren't local files (an authored walkthrough): no revert. */
	external: boolean
	onRevert: () => void
}) {
	if (hunk.synthetic)
		return (
			<div className="flex items-center gap-1.5 border-t border-solid border-x-0 border-b-0 border-editor-group-border px-2 py-1.5 text-[11px] text-description first:border-t-0">
				<span aria-hidden className="codicon codicon-info text-[12px]!" />
				{syntheticReason(hunk)}
			</div>
		)
	const open = actions.hunkOpen(hunk)
	const { added, removed } = countChanges(hunk.patch)
	return (
		<div
			className="border-t border-solid border-x-0 border-b-0 border-editor-group-border first:border-t-0"
			data-testid="walkthrough-hunk">
			<div className="flex h-6 items-center gap-1 pr-1 text-[11px] text-description hover:bg-list-hover">
				<button
					aria-expanded={open}
					aria-label={`${open ? "Collapse" : "Expand"} hunk ${hunk.header}`}
					className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-1 border-0 bg-transparent py-0 pr-1 pl-1.5 text-left font-mono text-[11px] text-description hover:text-foreground focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-(--vscode-focusBorder)"
					onClick={() => actions.toggleHunk(hunk)}
					type="button">
					<span aria-hidden className={`codicon codicon-chevron-${open ? "down" : "right"} text-[12px]!`} />
					<span className="min-w-0 truncate">{hunk.header}</span>
				</button>
				<ChangeCounts added={added} removed={removed} />
				{!(external || hunk.external) && (
					<HeaderIconButton
						className={ROW_ICON_CLASS}
						disabled={actions.busy}
						icon="discard"
						label="Revert hunk"
						onClick={onRevert}
					/>
				)}
			</div>
			{open && (
				<div className="border-t border-solid border-x-0 border-b-0 border-editor-group-border">
					<WalkthroughDiff annotations={actions.annotations(hunk)} hunk={hunk} notes={actions.lineNotes(hunk)} />
				</div>
			)}
		</div>
	)
}

function FileBlock({ file, actions, external }: { file: StopFile; actions: StopActions; external: boolean }) {
	const [confirm, setConfirm] = useState<RevertTarget>()
	const binary = file.hunks.every((hunk) => hunk.synthetic)
	// External hunks live outside the workspace (e.g. a merge request): no diff, no revert.
	const notLocal = external || file.hunks.every((hunk) => hunk.external)
	const slash = file.path.lastIndexOf("/")
	const name = file.path.slice(slash + 1)
	const dir = slash > 0 ? file.path.slice(0, slash) : ""
	const totals = file.hunks
		.filter((hunk) => !hunk.synthetic)
		.reduce(
			(sum, hunk) => {
				const counts = countChanges(hunk.patch)
				return { added: sum.added + counts.added, removed: sum.removed + counts.removed }
			},
			{ added: 0, removed: 0 },
		)
	return (
		<div className="overflow-hidden rounded-xs border border-solid border-editor-group-border" data-testid="walkthrough-file">
			<div className="flex h-7 items-center gap-1.5 border-b border-solid border-x-0 border-t-0 border-editor-group-border bg-code pr-1 pl-2 text-[12px]">
				<span aria-hidden className="codicon codicon-file text-[13px]! text-description" />
				<span className="ph-no-capture flex min-w-0 flex-1 items-baseline gap-1.5" title={file.path}>
					<span className="shrink-0 font-medium text-foreground">{name}</span>
					{dir && <span className="min-w-0 truncate text-[11px] text-description">{dir}</span>}
				</span>
				{!binary && <ChangeCounts {...totals} />}
				{!notLocal && (
					<HeaderIconButton
						className={ROW_ICON_CLASS}
						disabled={actions.busy}
						icon="diff"
						label="Open diff"
						onClick={() => actions.openDiff(file.fileId)}
					/>
				)}
				{!binary && !notLocal && (
					<HeaderIconButton
						className={ROW_ICON_CLASS}
						disabled={actions.busy}
						icon="discard"
						label="Revert file"
						onClick={() => setConfirm({ fileId: file.fileId })}
					/>
				)}
			</div>
			{confirm && (
				<InlineNotice
					actions={
						<>
							<Button
								disabled={actions.busy}
								onClick={() => void actions.revert(confirm).then((ok) => ok && setConfirm(undefined))}
								size="xs"
								variant="danger">
								{confirm.hunkId ? "Revert hunk" : "Revert file"}
							</Button>
							<Button onClick={() => setConfirm(undefined)} size="xs" variant="secondary">
								Cancel
							</Button>
						</>
					}
					className="rounded-none border-x-0 border-t-0 text-[11px]"
					role="alert"
					tone="warning">
					{confirm.hunkId ? "Revert this hunk?" : `Revert every change to ${name}?`} Later edits to the file block it.
				</InlineNotice>
			)}
			{file.hunks.map((hunk) => (
				<HunkBlock
					actions={actions}
					external={notLocal}
					hunk={hunk}
					key={hunk.id}
					onRevert={() => setConfirm({ fileId: file.fileId, hunkId: hunk.id })}
				/>
			))}
		</div>
	)
}

interface WalkthroughStopCardProps {
	walk: ChangeWalkthrough
	stop: WalkthroughStop
	/** 1-based; absent for support stops. */
	number?: number
	note: string
	/** Notes on lines of this stop's hunks (shown on the folded row's count). */
	lineNoteCount: number
	reviewed: boolean
	/** The stop's note box is open (the page owns it so N can open it). */
	editing: boolean
	actions: StopActions
	onEditing: (editing: boolean) => void
	onNote: (note: string) => void
	onReviewed: (reviewed: boolean) => void
}

/**
 * One stop. Its number is also its reviewed checkbox, so a stop can be marked where reading starts;
 * Mark reviewed leads the row at its end, where reading finishes. A reviewed stop folds to its
 * title row (click the title to look again), so the page gets shorter as the review goes.
 */
export function WalkthroughStopCard({
	walk,
	stop,
	number,
	note,
	lineNoteCount,
	reviewed,
	editing,
	actions,
	onEditing,
	onNote,
	onReviewed,
}: WalkthroughStopCardProps) {
	const [expanded, setExpanded] = useState(false)
	// A reviewed stop shows only its title until it's opened again.
	const [peek, setPeek] = useState(false)
	const files = stopFiles(walk, stop)
	const hasNote = !!note.trim()
	const folded = reviewed && !peek && !editing
	const notes = (hasNote ? 1 : 0) + lineNoteCount
	const toggleReviewed = () => {
		setPeek(false)
		onReviewed(!reviewed)
	}
	return (
		<article
			aria-label={stop.title}
			className={cn(
				"rounded-xs border border-solid transition-colors motion-reduce:transition-none",
				folded ? "px-3 py-1.5" : "px-3 py-2.5",
				reviewed ? "border-success/30 bg-success/5" : "border-editor-group-border",
			)}
			data-folded={folded ? "true" : undefined}
			data-stop-id={stop.id}
			data-testid="walkthrough-stop">
			<div className="flex items-center gap-2">
				<button
					aria-label={reviewed ? `Mark ${stop.title} not reviewed` : `Mark ${stop.title} reviewed`}
					aria-pressed={reviewed}
					className={cn(
						"group/check relative flex size-4.5 shrink-0 cursor-pointer items-center justify-center rounded-full border-solid p-0 text-[10px] font-semibold tabular-nums",
						reviewed
							? "border-0 bg-success/20 text-success"
							: "border-[1.5px] border-description/70 bg-transparent text-description hover:border-success hover:text-success",
					)}
					data-testid="walkthrough-stop-check"
					onClick={toggleReviewed}
					title={reviewed ? "Reviewed. Click to unmark (R)" : "Mark reviewed (R)"}
					type="button">
					{reviewed ? (
						<span aria-hidden className="codicon codicon-check text-[11px]!" />
					) : (
						<>
							{/* Swapped by opacity: the codicon class would override a display toggle. */}
							<span aria-hidden className="group-hover/check:opacity-0">
								{number ?? ""}
							</span>
							<span
								aria-hidden
								className="codicon codicon-check absolute text-[11px]! opacity-0 group-hover/check:opacity-100"
							/>
						</>
					)}
				</button>
				{reviewed ? (
					<button
						aria-expanded={!folded}
						className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 border-0 bg-transparent p-0 text-left text-description hover:text-foreground"
						onClick={() => setPeek(folded)}
						title={folded ? "Show this stop again" : "Fold it"}
						type="button">
						<h3 className="m-0 min-w-0 flex-1 truncate text-[13px] leading-5 font-semibold">{stop.title}</h3>
						{folded && notes > 0 && (
							<span className="shrink-0 text-[11px]" data-testid="walkthrough-stop-note-count">
								{notes} {notes === 1 ? "note" : "notes"}
							</span>
						)}
						<span
							aria-hidden
							className={`codicon codicon-chevron-${folded ? "right" : "down"} shrink-0 text-[12px]!`}
						/>
					</button>
				) : (
					<h3 className="m-0 min-w-0 flex-1 truncate text-[13px] leading-5 font-semibold">{stop.title}</h3>
				)}
			</div>
			{!folded && (
				<>
					{stop.prose && (
						<InlineCodeProse
							className="mt-1 text-xs leading-normal text-description"
							text={expanded && stop.detail ? stop.detail : stop.prose}
						/>
					)}
					{stop.detail && (
						<button
							aria-expanded={expanded}
							className="mt-0.5 cursor-pointer border-0 bg-transparent p-0 text-[11px] text-link hover:underline"
							onClick={() => setExpanded(!expanded)}
							type="button">
							{expanded ? "Show less" : "Show more"}
						</button>
					)}
					{files.length > 0 && (
						<div className="mt-2 flex flex-col gap-2">
							{files.map((file) => (
								<FileBlock actions={actions} external={walk.scope === "authored"} file={file} key={file.fileId} />
							))}
						</div>
					)}
					{hasNote && !editing && <NoteQuote label="Note" note={note} onEdit={() => onEditing(true)} />}
					{editing && (
						<NoteEditor
							chips
							label={`Note on ${stop.title}`}
							onChange={onNote}
							onDone={() => onEditing(false)}
							placeholder="Note on this stop…"
							value={note}
						/>
					)}
					<div className="mt-2.5 flex items-center gap-1.5">
						<Button
							aria-pressed={reviewed}
							className={cn("h-6 gap-1 px-2", reviewed && "text-success")}
							onClick={toggleReviewed}
							size="xs"
							title="R"
							variant="secondary">
							<span
								aria-hidden
								className={cn("codicon text-[12px]!", reviewed ? "codicon-pass-filled" : "codicon-circle-large")}
							/>
							{reviewed ? "Reviewed" : "Mark reviewed"}
						</Button>
						<Button
							className="h-6 gap-1 px-2"
							onClick={() => onEditing(!editing)}
							size="xs"
							title="N"
							variant="ghost">
							<span aria-hidden className="codicon codicon-comment text-[12px]!" />
							{hasNote ? "Edit note" : "Add note"}
						</Button>
					</div>
				</>
			)}
		</article>
	)
}
