import { hunkBodyLines, hunkLineNumbers, type WalkthroughAnnotation, type WalkthroughHunk } from "@shared/Walkthrough"
import { Fragment, useRef, useState } from "react"
import { cn } from "@/lib/utils"
import type { LineRange } from "./reviewState"
import { InlineCodeProse, NoteEditor } from "./WalkthroughNote"

/** "turn3" → "Turn 3"; the checkpoint-recovered turn has no number. */
function turnLabel(turnId: string | undefined): string {
	if (!turnId) return "Agent"
	if (turnId === "earlier") return "Earlier"
	return `Turn ${turnId.replace(/^turn/, "")}`
}

const ROW_BACKGROUND: Record<string, string | undefined> = {
	"+": "var(--vscode-diffEditor-insertedTextBackground)",
	"-": "var(--vscode-diffEditor-removedTextBackground)",
}

/** A note inside the diff, above the line it explains. */
function AnnotationRow({ annotation }: { annotation: WalkthroughAnnotation }) {
	const turn = annotation.kind === "turn"
	return (
		<div
			className="flex gap-1.5 border-y border-x-0 border-l-2 border-solid border-y-editor-group-border border-l-description/50 bg-code py-1 pr-2 pl-1.5 font-sans text-[11px] leading-normal text-description"
			data-kind={annotation.kind}
			data-testid="walkthrough-annotation">
			<span className="shrink-0 pt-px text-[10px] uppercase tracking-wider">
				{turn ? turnLabel(annotation.turnId) : "Why"}
			</span>
			<InlineCodeProse className={cn("min-w-0", turn && "italic")} text={turn ? `“${annotation.text}”` : annotation.text} />
		</div>
	)
}

/** A note on a selection inside this hunk. */
export interface HunkNote extends LineRange {
	note: string
	quote?: string
}

export interface LineNotes {
	/** Saved notes on this hunk. */
	list: HunkNote[]
	set: (range: LineRange, note: string, quote?: string) => void
	/** The selection whose note box is open, if it's in this hunk. */
	editing?: LineRange & { quote?: string }
	onEdit: (range: (LineRange & { quote?: string }) | undefined) => void
}

/** The body line a DOM point sits in, if it's one of this diff's lines. */
function lineAt(node: Node | null, container: HTMLElement): number | undefined {
	const element = node instanceof Element ? node : node?.parentElement
	const row = element?.closest<HTMLElement>("[data-line-index]")
	return row && container.contains(row) ? Number(row.dataset.lineIndex) : undefined
}

/**
 * One hunk's diff with line numbers, the notes that explain it (above the lines they're about)
 * and the reviewer's own notes. Select any part of it (like quoting a chat message) and Note
 * opens a box under the selection; the note covers every selected line. A line number notes that
 * one line.
 */
export function WalkthroughDiff({
	hunk,
	annotations,
	notes,
}: {
	hunk: WalkthroughHunk
	annotations: WalkthroughAnnotation[]
	notes: LineNotes
}) {
	const body = hunkBodyLines(hunk.patch)
	const numbers = hunkLineNumbers(hunk)
	const container = useRef<HTMLDivElement>(null)
	// A selection waiting for its Note button: the lines, the exact text, and where to put the button.
	const [pending, setPending] = useState<LineRange & { quote?: string; top: number; left: number }>()

	const span = (range: LineRange) => {
		const first = numbers[range.start]
		const last = numbers[range.end]
		const old = body.slice(range.start, range.end + 1).every((line) => line.startsWith("-")) ? "old " : ""
		return range.end > range.start && first !== last ? `${old}lines ${first}–${last}` : `${old}line ${first}`
	}
	const covers = (range: LineRange | undefined, index: number) => !!range && index >= range.start && index <= range.end

	const onMouseUp = () => {
		// After the browser settles the selection.
		setTimeout(() => {
			const root = container.current
			const selection = window.getSelection()
			const text = selection?.toString() ?? ""
			if (!root || !selection || selection.isCollapsed || !text.trim() || selection.rangeCount === 0) return
			const range = selection.getRangeAt(0)
			const a = lineAt(range.startContainer, root)
			const b = lineAt(range.endContainer, root)
			if (a === undefined || b === undefined) return
			const start = Math.min(a, b)
			const end = Math.max(a, b)
			// Whole lines need no quote; a part of a line (or of several) keeps exactly what was picked.
			const whole = body
				.slice(start, end + 1)
				.map((line) => line.slice(1))
				.join("\n")
			const quote = text.trim() === whole.trim() ? undefined : text.slice(0, 2000)
			const rect = range.getBoundingClientRect()
			const box = root.getBoundingClientRect()
			setPending({
				start,
				end,
				quote,
				top: rect.bottom - box.top + root.scrollTop + 2,
				left: Math.max(0, Math.min(rect.left - box.left + root.scrollLeft, root.scrollWidth - 64)),
			})
		}, 0)
	}

	const noteRow = (saved: HunkNote) => (
		<button
			className="flex w-full cursor-pointer gap-1.5 border-y border-x-0 border-l-2 border-solid border-y-editor-group-border border-l-link bg-code py-1 pr-2 pl-1.5 text-left font-sans text-[11.5px] leading-normal text-foreground hover:bg-list-hover"
			data-testid="walkthrough-line-note"
			key={`${saved.start}-${saved.end}`}
			onClick={() => notes.onEdit(saved)}
			title="Edit"
			type="button">
			<span className="shrink-0 pt-px text-[10px] uppercase tracking-wider text-link">You · {span(saved)}</span>
			<span className="min-w-0 whitespace-pre-wrap break-words">{saved.note.trim()}</span>
		</button>
	)

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: selecting text is a mouse gesture; line numbers are the keyboard path
		<div
			aria-label={`Diff of ${hunk.path}`}
			className="relative overflow-x-auto font-mono text-[11px] leading-5"
			data-testid="walkthrough-diff"
			onMouseDown={(event) => {
				if (!(event.target as Element).closest("[data-note-selection]")) setPending(undefined)
			}}
			onMouseUp={onMouseUp}
			ref={container}>
			{body.map((raw, index) => {
				const sign = raw[0] === "+" || raw[0] === "-" ? raw[0] : " "
				const editing = notes.editing
				const marked = covers(editing, index) || notes.list.some((saved) => covers(saved, index))
				const ending = notes.list.filter((saved) => saved.end === index && saved.note.trim())
				return (
					<Fragment key={index}>
						{annotations
							.filter((annotation) => annotation.line === index)
							.map((annotation) => (
								<AnnotationRow annotation={annotation} key={`${annotation.kind}:${annotation.text}`} />
							))}
						<div
							className="relative flex min-w-0"
							data-line-index={index}
							data-testid="walkthrough-diff-line"
							style={{
								background: ROW_BACKGROUND[sign],
								// Lines a note covers carry its blue edge.
								boxShadow: marked ? "inset 2px 0 0 var(--vscode-textLink-foreground)" : undefined,
							}}>
							<button
								aria-label={`Note on ${span({ start: index, end: index })}`}
								className="w-9 shrink-0 cursor-pointer select-none border-0 bg-transparent p-0 pr-1.5 text-right font-mono text-[11px] leading-5 text-description/60 hover:text-foreground hover:underline"
								onClick={() => notes.onEdit({ start: index, end: index })}
								title="Note on this line (or select text to note it)"
								type="button">
								{numbers[index]}
							</button>
							<span aria-hidden className="w-3 shrink-0 select-none pl-0.5">
								{sign === "-" ? "−" : sign}
							</span>
							<span className="whitespace-pre">{raw.slice(1) || " "}</span>
						</div>
						{ending
							.filter((saved) => !(editing && editing.start === saved.start && editing.end === saved.end))
							.map(noteRow)}
						{editing?.end === index && (
							<div className="border-y border-x-0 border-solid border-editor-group-border bg-code px-2 py-1.5 font-sans">
								{editing.quote && (
									<div className="mb-1 line-clamp-2 border-0 border-l-2 border-solid border-description/50 pl-1.5 font-mono text-[11px] text-description">
										{editing.quote}
									</div>
								)}
								<NoteEditor
									className="mt-0"
									label={`Note on ${span(editing)}`}
									onChange={(value) => notes.set(editing, value, editing.quote)}
									onDone={() => notes.onEdit(undefined)}
									placeholder={`Note on ${span(editing)}…`}
									value={
										notes.list.find((saved) => saved.start === editing.start && saved.end === editing.end)
											?.note ?? ""
									}
								/>
							</div>
						)}
					</Fragment>
				)
			})}
			{pending && (
				<button
					className="absolute z-10 flex h-5.5 cursor-pointer items-center gap-1 rounded-xs border border-solid border-editor-group-border bg-menu px-1.5 font-sans text-[11px] text-menu-foreground shadow-md hover:bg-list-hover"
					data-note-selection
					data-testid="walkthrough-note-selection"
					onClick={() => {
						notes.onEdit({ start: pending.start, end: pending.end, quote: pending.quote })
						window.getSelection()?.removeAllRanges()
						setPending(undefined)
					}}
					style={{ top: pending.top, left: pending.left }}
					type="button">
					<span aria-hidden className="codicon codicon-comment text-[12px]!" />
					Note
				</button>
			)}
		</div>
	)
}
