import type { ChangeWalkthrough, WalkthroughHunk, WalkthroughStop } from "@shared/Walkthrough"
import { useState } from "react"
import { HeaderIconButton } from "@/components/chat/task-header/HeaderIconButton"
import { InlineNotice } from "@/components/common/InlineNotice"
import { NotebookDiff } from "@/components/taskGroup/NotebookDiff"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { countChanges, patchToDiffLines, type StopFile, splitInlineCode, stopFiles, syntheticReason } from "./walkthroughUtils"

/** Quick chips from the round 3 mockup; each fills the note box and stays editable. */
export const QUICK_NOTES = ["Why this approach?", "Add a test for this.", "Rename for clarity."]

/** Pill chips under a note box (also the script helper's choices). */
const CHIP_CLASS =
	"cursor-pointer rounded-full border border-solid border-editor-group-border bg-transparent px-2 py-px text-[11px] text-description hover:bg-list-hover hover:text-foreground"

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
}

/** A compact codicon action inside file and hunk headers. */
const ROW_ICON_CLASS = "size-5 [&>.codicon]:text-[13px]!"

export function InlineCodeProse({ text, className }: { text: string; className?: string }) {
	return (
		<p className={cn("m-0 whitespace-pre-line break-words", className)}>
			{splitInlineCode(text).map((part, index) =>
				part.code ? (
					<code className="rounded-xs bg-code px-1 font-mono text-[11px]" key={index}>
						{part.text}
					</code>
				) : (
					<span key={index}>{part.text}</span>
				),
			)}
		</p>
	)
}

/** A note box with quick chips. Used by each stop and by the overall note. */
export function NoteEditor({
	value,
	placeholder,
	label,
	chips,
	onChange,
	onDone,
}: {
	value: string
	placeholder: string
	label: string
	chips?: boolean
	onChange: (value: string) => void
	onDone: () => void
}) {
	return (
		<div className="mt-2 rounded-xs border border-solid border-(--vscode-focusBorder) bg-input-background p-2">
			<textarea
				aria-label={label}
				autoFocus
				className="block w-full resize-y border-0 bg-transparent p-0 font-[inherit] text-xs leading-normal text-input-foreground outline-none placeholder:text-input-placeholder"
				onChange={(event) => onChange(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === "Escape" || (event.key === "Enter" && (event.metaKey || event.ctrlKey))) {
						event.preventDefault()
						event.stopPropagation()
						onDone()
					}
				}}
				placeholder={placeholder}
				rows={2}
				value={value}
			/>
			<div className="mt-1.5 flex flex-wrap items-center gap-1">
				{chips &&
					QUICK_NOTES.map((text) => (
						<button
							className={CHIP_CLASS}
							key={text}
							onClick={() => onChange(value.trim() ? `${value.trimEnd()} ${text}` : text)}
							type="button">
							{text.replace(/[.?]$/, "")}
						</button>
					))}
				<span className="flex-1" />
				<Button onClick={onDone} size="xs" variant="secondary">
					Done
				</Button>
			</div>
		</div>
	)
}

/** "+3 −1" in the git decoration colors. */
function ChangeCounts({ added, removed }: { added: number; removed: number }) {
	return (
		<span className="flex shrink-0 items-center gap-1 font-mono text-[11px] tabular-nums">
			<span className="text-(--vscode-gitDecoration-addedResourceForeground)">+{added}</span>
			<span className="text-(--vscode-gitDecoration-deletedResourceForeground)">−{removed}</span>
		</span>
	)
}

function HunkBlock({ hunk, actions, onRevert }: { hunk: WalkthroughHunk; actions: StopActions; onRevert: () => void }) {
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
				<HeaderIconButton
					className={ROW_ICON_CLASS}
					disabled={actions.busy}
					icon="discard"
					label="Revert hunk"
					onClick={onRevert}
				/>
			</div>
			{open && (
				<div className="[&>div]:rounded-none [&>div]:border-x-0 [&>div]:border-b-0 [&>div]:border-t [&>div]:border-solid [&>div]:border-editor-group-border">
					<NotebookDiff lines={patchToDiffLines(hunk.patch)} />
				</div>
			)}
		</div>
	)
}

function FileBlock({ file, actions }: { file: StopFile; actions: StopActions }) {
	const [confirm, setConfirm] = useState<RevertTarget>()
	const binary = file.hunks.every((hunk) => hunk.synthetic)
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
				<HeaderIconButton
					className={ROW_ICON_CLASS}
					disabled={actions.busy}
					icon="diff"
					label="Open diff"
					onClick={() => actions.openDiff(file.fileId)}
				/>
				{!binary && (
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
					hunk={hunk}
					key={hunk.id}
					onRevert={() => setConfirm({ fileId: file.fileId, hunkId: hunk.id })}
				/>
			))}
		</div>
	)
}

/** A saved note, shown as a quote on its stop or under Overall; click to edit. */
export function NoteQuote({ label, note, onEdit }: { label: string; note: string; onEdit: () => void }) {
	return (
		<button
			className="mt-2 block w-full cursor-pointer rounded-xs border-0 border-l-2 border-solid border-link bg-code px-2 py-1.5 text-left font-[inherit] text-xs text-foreground hover:bg-list-hover focus-visible:outline focus-visible:outline-1 focus-visible:outline-(--vscode-focusBorder)"
			onClick={onEdit}
			title="Edit"
			type="button">
			<span className="mb-0.5 flex items-center gap-1 text-[10px] font-medium uppercase tracking-wider text-link">
				<span aria-hidden className="codicon codicon-comment text-[11px]!" />
				{label}
			</span>
			<span className="block whitespace-pre-wrap break-words">{note}</span>
		</button>
	)
}

interface WalkthroughStopCardProps {
	walk: ChangeWalkthrough
	stop: WalkthroughStop
	/** 1-based; absent for support stops. */
	number?: number
	note: string
	reviewed: boolean
	actions: StopActions
	onNote: (note: string) => void
	onReviewed: (reviewed: boolean) => void
}

export function WalkthroughStopCard({
	walk,
	stop,
	number,
	note,
	reviewed,
	actions,
	onNote,
	onReviewed,
}: WalkthroughStopCardProps) {
	const [editing, setEditing] = useState(false)
	const files = stopFiles(walk, stop)
	const hasNote = !!note.trim()
	return (
		<article
			aria-label={stop.title}
			className={cn(
				"rounded-xs border border-solid px-3 py-2.5 transition-colors motion-reduce:transition-none",
				reviewed ? "border-success/30 bg-success/5" : "border-editor-group-border",
			)}
			data-testid="walkthrough-stop">
			<div className="flex items-center gap-2">
				{number !== undefined && (
					<span
						aria-hidden
						className={cn(
							"flex size-4.5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold tabular-nums",
							reviewed ? "bg-success/20 text-success" : "bg-badge-background text-badge-foreground",
						)}>
						{reviewed ? <span className="codicon codicon-check text-[11px]!" /> : number}
					</span>
				)}
				<h3
					className={cn(
						"m-0 min-w-0 flex-1 truncate text-[13px] leading-5 font-semibold",
						reviewed && "text-description",
					)}>
					{stop.title}
				</h3>
				{reviewed && number === undefined && (
					<span aria-label="Reviewed" className="codicon codicon-check text-[12px]! text-success" role="img" />
				)}
			</div>
			{stop.prose && <InlineCodeProse className="mt-1 text-xs leading-normal text-description" text={stop.prose} />}
			{files.length > 0 && (
				<div className="mt-2 flex flex-col gap-2">
					{files.map((file) => (
						<FileBlock actions={actions} file={file} key={file.fileId} />
					))}
				</div>
			)}
			{hasNote && !editing && <NoteQuote label="Note" note={note} onEdit={() => setEditing(true)} />}
			{editing && (
				<NoteEditor
					chips
					label={`Note on ${stop.title}`}
					onChange={onNote}
					onDone={() => setEditing(false)}
					placeholder="Note on this stop…"
					value={note}
				/>
			)}
			<div className="mt-2.5 flex items-center gap-1.5">
				<Button className="h-6 gap-1 px-2" onClick={() => setEditing(!editing)} size="xs" variant="secondary">
					<span aria-hidden className="codicon codicon-comment text-[12px]!" />
					{hasNote ? "Edit note" : "Add note"}
				</Button>
				<span className="flex-1" />
				<Button
					aria-pressed={reviewed}
					className={cn("h-6 gap-1 px-2", reviewed && "text-success")}
					onClick={() => onReviewed(!reviewed)}
					size="xs"
					variant="secondary">
					<span
						aria-hidden
						className={cn("codicon text-[12px]!", reviewed ? "codicon-pass-filled" : "codicon-circle-large")}
					/>
					{reviewed ? "Reviewed" : "Mark reviewed"}
				</Button>
			</div>
		</article>
	)
}
