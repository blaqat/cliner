import type { ChangeWalkthrough, WalkthroughHunk, WalkthroughStop } from "@shared/Walkthrough"
import { useState } from "react"
import { InlineNotice } from "@/components/common/InlineNotice"
import { LinkButton } from "@/components/common/LinkButton"
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
}

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
		<div className="mt-2 rounded-xs border border-solid border-(--vscode-focusBorder) bg-input-background p-1.5">
			<textarea
				aria-label={label}
				autoFocus
				className="block w-full resize-y border-0 bg-transparent p-0 font-[inherit] text-xs text-input-foreground outline-none"
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

function HunkBlock({ hunk, actions, onRevert }: { hunk: WalkthroughHunk; actions: StopActions; onRevert: () => void }) {
	const [open, setOpen] = useState(true)
	if (hunk.synthetic) return <div className="px-2 py-1.5 text-[11px] text-description">{syntheticReason(hunk)}</div>
	const { added, removed } = countChanges(hunk.patch)
	return (
		<div className="border-t border-solid border-x-0 border-b-0 border-editor-group-border first:border-t-0">
			<div className="flex items-center gap-1.5 px-2 py-0.5 text-[11px] text-description">
				<button
					aria-expanded={open}
					aria-label={`${open ? "Collapse" : "Expand"} hunk ${hunk.header}`}
					className="flex min-w-0 cursor-pointer items-center gap-1 border-0 bg-transparent p-0 font-mono text-[11px] text-description hover:text-foreground"
					onClick={() => setOpen(!open)}
					type="button">
					<span aria-hidden className={`codicon codicon-chevron-${open ? "down" : "right"} text-[11px]!`} />
					<span className="truncate">{hunk.header}</span>
				</button>
				<span className="text-(--vscode-gitDecoration-addedResourceForeground)">+{added}</span>
				<span className="text-(--vscode-gitDecoration-deletedResourceForeground)">−{removed}</span>
				<span className="flex-1" />
				<LinkButton disabled={actions.busy} onClick={onRevert}>
					Revert hunk
				</LinkButton>
			</div>
			{open && (
				<div className="[&>div]:rounded-none [&>div]:border-0">
					<NotebookDiff lines={patchToDiffLines(hunk.patch)} />
				</div>
			)}
		</div>
	)
}

function FileBlock({ file, actions }: { file: StopFile; actions: StopActions }) {
	const [confirm, setConfirm] = useState<RevertTarget>()
	const binary = file.hunks.every((hunk) => hunk.synthetic)
	return (
		<div
			className="mt-2 overflow-hidden rounded-xs border border-solid border-editor-group-border"
			data-testid="walkthrough-file">
			<div className="flex items-center gap-1.5 bg-code px-2 py-1 text-[11px]">
				<span aria-hidden className="codicon codicon-file text-[12px]! text-description" />
				<span className="ph-no-capture min-w-0 flex-1 truncate font-mono" title={file.path}>
					{file.path}
				</span>
				<LinkButton disabled={actions.busy} onClick={() => actions.openDiff(file.fileId)}>
					Open diff
				</LinkButton>
				{!binary && (
					<LinkButton disabled={actions.busy} onClick={() => setConfirm({ fileId: file.fileId })}>
						Revert file
					</LinkButton>
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
					className="rounded-none border-x-0 border-b-0 text-[11px]"
					role="alert"
					tone="warning">
					{confirm.hunkId ? "Revert this hunk?" : `Revert every change to ${file.path.split("/").pop()}?`} Later edits
					to the file block it.
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
			className={cn("rounded-xs border border-solid border-editor-group-border px-2.5 py-2", reviewed && "bg-success/5")}
			data-testid="walkthrough-stop">
			<div className="flex items-center gap-1.5">
				{number !== undefined && (
					<span
						className={cn(
							"flex size-4 shrink-0 items-center justify-center rounded-full text-[10px]",
							reviewed ? "bg-success/20 text-success" : "bg-badge-background text-badge-foreground",
						)}>
						{number}
					</span>
				)}
				<h3 className={cn("m-0 min-w-0 flex-1 truncate text-[13px] font-semibold", reviewed && "text-description")}>
					{stop.title}
				</h3>
				{reviewed && (
					<span aria-label="Reviewed" className="codicon codicon-check text-[12px]! text-success" role="img" />
				)}
			</div>
			{stop.prose && <InlineCodeProse className="mt-1 text-xs text-description" text={stop.prose} />}
			{files.map((file) => (
				<FileBlock actions={actions} file={file} key={file.fileId} />
			))}
			{hasNote && !editing && (
				<div className="mt-2 rounded-xs border-l-2 border-solid border-y-0 border-r-0 border-link bg-code px-2 py-1 text-xs">
					<span className="font-semibold text-link">Note</span> · <span className="whitespace-pre-wrap">{note}</span>
				</div>
			)}
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
			<div className="mt-2 flex items-center gap-1.5">
				<Button onClick={() => setEditing(!editing)} size="xs" variant="secondary">
					<span aria-hidden className="codicon codicon-edit text-[11px]!" />
					{hasNote ? "Edit note" : "Add note"}
				</Button>
				<span className="flex-1" />
				<Button
					aria-pressed={reviewed}
					className={cn(reviewed && "text-success")}
					onClick={() => onReviewed(!reviewed)}
					size="xs"
					variant="secondary">
					{reviewed && <span aria-hidden className="codicon codicon-check text-[11px]!" />}
					{reviewed ? "Reviewed" : "Mark reviewed"}
				</Button>
			</div>
		</article>
	)
}
