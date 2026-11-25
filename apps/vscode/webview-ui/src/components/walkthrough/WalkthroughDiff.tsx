import { hunkBodyLines, hunkLineNumbers, type WalkthroughAnnotation, type WalkthroughHunk } from "@shared/Walkthrough"
import { Fragment, type ReactNode, useMemo, useRef, useState } from "react"
import { cn } from "@/lib/utils"
import "../common/codeblock-parser.css"
import { diffCode as code, highlightDiff } from "./diffHighlight"
import { type PlacedReviewNote, REVIEW_KINDS, sortReviewNotes } from "./reviewNotes"
import type { LineRange } from "./reviewState"
import { type AskOpen, type DiffAsk, WalkthroughAsk } from "./WalkthroughAsk"
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

/** Cline's notes on this hunk's lines: a kind icon in the gutter that opens the note under its lines. */
export interface DiffReview {
	/** Line notes in this hunk that the filter shows. */
	notes: PlacedReviewNote[]
	isOpen: (id: string) => boolean
	isDismissed: (id: string) => boolean
	/** A marker was clicked: the notes starting on that line. */
	onMarker: (ids: string[]) => void
	renderCallout: (placed: PlacedReviewNote) => ReactNode
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
	review,
	ask,
}: {
	hunk: WalkthroughHunk
	annotations: WalkthroughAnnotation[]
	notes: LineNotes
	review?: DiffReview
	ask?: DiffAsk
}) {
	const asking = ask?.open
	const setAsking = (open: AskOpen) => ask?.onOpen(open)
	// The line whose number (or Ask) has keyboard focus: its Ask button joins the tab order.
	const [focusLine, setFocusLine] = useState<number>()
	const body = useMemo(() => hunkBodyLines(hunk.patch), [hunk.patch])
	const highlighted = useMemo(() => highlightDiff(body, hunk.path), [body, hunk.path])
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
	const cline = review?.notes ?? []
	const gutter = cline.length > 0

	const marker = (index: number) => {
		const here = sortReviewNotes(cline.filter((placed) => placed.line === index))
		// Lines a ranged note covers after its first get a thin rail, so its extent reads at a glance.
		const rail = cline.some((p) => p.line !== undefined && p.endLine !== undefined && index > p.line && index <= p.endLine)
		const first = here[0]
		if (!first)
			return (
				<span aria-hidden className="relative w-4 shrink-0 select-none">
					{rail && <i className="absolute inset-y-0 left-[7px] w-px bg-description/45" />}
				</span>
			)
		const kind = REVIEW_KINDS[first.note.kind]
		const ids = here.map((placed) => placed.note.id)
		const open = ids.some((id) => review?.isOpen(id))
		const label = `Cline · ${kind.label}: ${first.note.title}${here.length > 1 ? ` and ${here.length - 1} more` : ""}`
		return (
			<span className="flex w-4 shrink-0 select-none items-center justify-center">
				<button
					aria-expanded={open}
					aria-label={label}
					className={cn(
						"flex size-4 cursor-pointer items-center justify-center rounded-xs border-0 bg-transparent p-0 text-description hover:bg-list-hover hover:text-foreground",
						open && "bg-list-hover text-foreground",
						ids.every((id) => review?.isDismissed(id)) && "opacity-40",
					)}
					data-kind={first.note.kind}
					data-testid="review-marker"
					onClick={() => review?.onMarker(ids)}
					title={label}
					type="button">
					<span aria-hidden className={cn("codicon text-[11px]!", `codicon-${kind.icon}`, kind.tone)} />
				</button>
			</span>
		)
	}

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
				.map((line) => code(line))
				.join("\n")
			const quote = text.trim() === whole.trim() ? undefined : text.slice(0, 2000)
			const rect = range.getBoundingClientRect()
			const box = root.getBoundingClientRect()
			setPending({
				start,
				end,
				quote,
				top: rect.bottom - box.top + root.scrollTop + 2,
				left: Math.max(0, Math.min(rect.left - box.left + root.scrollLeft, root.clientWidth - 130)),
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
				const marked =
					covers(editing, index) ||
					covers(asking, index) ||
					notes.list.some((saved) => covers(saved, index)) ||
					ask?.threads.some((thread) => index >= thread.line && index <= thread.endLine)
				const ending = notes.list.filter((saved) => saved.end === index && saved.note.trim())
				return (
					<Fragment key={index}>
						{annotations
							.filter((annotation) => annotation.line === index)
							.map((annotation) => (
								<AnnotationRow annotation={annotation} key={`${annotation.kind}:${annotation.text}`} />
							))}
						<div
							// As wide as its code (at least the view), ending in the Ask slot.
							className="group/line flex w-max min-w-full"
							data-line-index={index}
							data-testid="walkthrough-diff-line"
							onBlur={(event) => {
								if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocusLine(undefined)
							}}
							onFocus={() => setFocusLine(index)}
							style={{
								background: ROW_BACKGROUND[sign],
								// Lines a note covers carry its blue edge.
								boxShadow: marked ? "inset 2px 0 0 var(--vscode-textLink-foreground)" : undefined,
							}}>
							{gutter && marker(index)}
							<button
								aria-keyshortcuts={ask ? "A" : undefined}
								aria-label={`Note on ${span({ start: index, end: index })}`}
								className="w-9 shrink-0 cursor-pointer select-none border-0 bg-transparent p-0 pr-1.5 text-right font-mono text-[11px] leading-5 text-description/60 hover:text-foreground hover:underline"
								onClick={() => notes.onEdit({ start: index, end: index })}
								onKeyDown={(event) => {
									if (event.key.toLowerCase() === "a" && ask) {
										event.preventDefault()
										setAsking({ start: index, end: index })
									}
								}}
								title={
									ask
										? "Note on this line. Ask (or A) asks about it; select text for Note or Ask on several lines."
										: "Note on this line. Select text to note several lines."
								}
								type="button">
								{numbers[index]}
							</button>
							<span aria-hidden className="w-3 shrink-0 select-none pl-0.5">
								{sign === "-" ? "−" : sign}
							</span>
							<span className="whitespace-pre">
								{highlighted?.[index]?.length ? highlighted[index] : code(raw) || " "}
							</span>
							{ask && (
								// Pinned to the right edge but zero-width, so it costs the code no room. Only the small
								// chip, shown on hover or focus, takes the pointer: a drag starting on the code beside it
								// still selects text.
								<span
									className="pointer-events-none sticky right-0 ml-auto w-0 shrink-0 select-none"
									data-ask-slot>
									{!pending && (
										<button
											aria-label={`Ask why about ${span({ start: index, end: index })}`}
											className="pointer-events-auto absolute top-0.5 right-0.5 hidden h-4 w-4 cursor-pointer items-center justify-center rounded-xs border border-solid border-editor-group-border bg-menu p-0 text-menu-foreground shadow-sm hover:bg-list-hover focus-visible:flex focus-visible:outline focus-visible:outline-1 focus-visible:outline-(--vscode-focusBorder) group-hover/line:flex group-focus-within/line:flex"
											data-testid="walkthrough-line-ask"
											onClick={() => setAsking({ start: index, end: index })}
											tabIndex={focusLine === index ? 0 : -1}
											title="Ask why about this line (A). Opens a question box; asking starts a model call."
											type="button">
											<span aria-hidden className="codicon codicon-sparkle text-[10px]!" />
										</button>
									)}
								</span>
							)}
						</div>
						{cline
							.filter((placed) => (placed.endLine ?? placed.line) === index && review?.isOpen(placed.note.id))
							.map((placed) => (
								<div
									className="border-y border-x-0 border-solid border-editor-group-border bg-code font-sans"
									data-review-callout={placed.note.id}
									data-testid="review-callout"
									key={placed.note.id}>
									{review?.renderCallout(placed)}
								</div>
							))}
						{ending
							.filter((saved) => !(editing && editing.start === saved.start && editing.end === saved.end))
							.map(noteRow)}
						{ask?.threads
							.filter((thread) => thread.endLine === index)
							.map((thread) => (
								<WalkthroughAsk
									ask={ask}
									key={thread.id}
									range={{
										start: thread.line,
										end: thread.endLine,
										quote: thread.quote,
										reviewNote: thread.reviewNote,
									}}
									thread={thread}
								/>
							))}
						{ask && asking?.end === index && (
							<WalkthroughAsk
								ask={ask}
								initial={{ question: asking.question, submit: asking.submit }}
								key={asking.id}
								// Ask instead: once its own question is answered, it replaces the (unchanged) note it came from.
								onAsked={(question) => ask.onAnswered(asking, question)}
								// Each box closes and keeps the draft of itself only, never a box opened after it.
								onClose={() => ask.onUpdate(asking.id, undefined)}
								onDraft={(question) => ask.onUpdate(asking.id, { question, submit: false })}
								range={{
									start: asking.start,
									end: asking.end,
									quote: asking.quote,
									reviewNote: asking.reviewNote,
								}}
							/>
						)}
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
									onAsk={
										ask &&
										(() => {
											const saved =
												notes.list.find(
													(saved) => saved.start === editing.start && saved.end === editing.end,
												)?.note ?? ""
											const text = saved.trim()
											notes.onEdit(undefined)
											setAsking({
												start: editing.start,
												end: editing.end,
												quote: editing.quote,
												...(text
													? { question: text, submit: true, fromNote: { text: saved, question: text } }
													: {}),
											})
										})
									}
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
				<div
					className="absolute z-10 flex items-center rounded-xs border border-solid border-editor-group-border bg-menu shadow-md"
					data-note-selection
					style={{ top: pending.top, left: pending.left }}>
					<button
						className="flex h-5.5 cursor-pointer items-center gap-1 border-0 bg-transparent px-1.5 font-sans text-[11px] text-menu-foreground hover:bg-list-hover"
						data-note-selection
						data-testid="walkthrough-note-selection"
						onClick={() => {
							notes.onEdit({ start: pending.start, end: pending.end, quote: pending.quote })
							window.getSelection()?.removeAllRanges()
							setPending(undefined)
						}}
						type="button">
						<span aria-hidden className="codicon codicon-comment text-[12px]!" />
						Note
					</button>
					{ask && (
						<button
							className="flex h-5.5 cursor-pointer items-center gap-1 border-0 border-l border-solid border-editor-group-border bg-transparent px-1.5 font-sans text-[11px] text-menu-foreground hover:bg-list-hover"
							data-note-selection
							onClick={() => {
								setAsking({ start: pending.start, end: pending.end, quote: pending.quote })
								window.getSelection()?.removeAllRanges()
								setPending(undefined)
							}}
							title="Ask about these lines. Opens a question box; submitting starts a model call."
							type="button">
							<span aria-hidden className="codicon codicon-sparkle text-[12px]!" />
							Ask
						</button>
					)}
				</div>
			)}
		</div>
	)
}
