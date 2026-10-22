import { hunkBodyLines, hunkLineNumbers, type WalkthroughAnnotation, type WalkthroughHunk } from "@shared/Walkthrough"
import { Fragment } from "react"
import { cn } from "@/lib/utils"
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

export interface LineNotes {
	/** The saved note on a body line, if any. */
	get: (line: number) => string
	set: (line: number, note: string) => void
	/** The body line whose note box is open, if it's in this hunk. */
	editing?: number
	onEdit: (line: number | undefined) => void
}

/**
 * One hunk's diff with line numbers, the notes that explain it (above the lines they're about)
 * and the reviewer's own line notes (under their lines). Hovering a line offers ＋ to note it.
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
	return (
		<div
			aria-label={`Diff of ${hunk.path}`}
			className="overflow-x-auto font-mono text-[11px] leading-5"
			data-testid="walkthrough-diff">
			{body.map((raw, index) => {
				const sign = raw[0] === "+" || raw[0] === "-" ? raw[0] : " "
				const note = notes.get(index)
				const editing = notes.editing === index
				// A removed line is numbered in the old file, so say so where it could be confused.
				const where = `${sign === "-" ? "old line" : "line"} ${numbers[index]}`
				return (
					<Fragment key={index}>
						{annotations
							.filter((annotation) => annotation.line === index)
							.map((annotation) => (
								<AnnotationRow annotation={annotation} key={`${annotation.kind}:${annotation.text}`} />
							))}
						<div
							className={cn(
								"group/line relative flex min-w-0",
								editing && "outline outline-1 -outline-offset-1 outline-(--vscode-focusBorder)",
							)}
							data-testid="walkthrough-diff-line"
							style={{ background: ROW_BACKGROUND[sign] }}>
							<button
								aria-label={`Note on ${where}`}
								className="absolute top-0.5 left-0.5 flex size-4 cursor-pointer items-center justify-center rounded-xs border-0 bg-(--vscode-button-background) p-0 text-(--vscode-button-foreground) opacity-0 group-hover/line:opacity-100 focus-visible:opacity-100"
								onClick={() => notes.onEdit(editing ? undefined : index)}
								title="Note on this line"
								type="button">
								<span aria-hidden className="codicon codicon-add text-[11px]!" />
							</button>
							<span aria-hidden className="w-9 shrink-0 select-none pr-1.5 text-right text-description/60">
								{numbers[index]}
							</span>
							<span className="whitespace-pre pl-0.5">
								{sign === "-" ? "−" : sign}
								{raw.slice(1) || " "}
							</span>
						</div>
						{editing ? (
							<div className="border-y border-x-0 border-solid border-editor-group-border bg-code px-2 py-1.5 font-sans">
								<NoteEditor
									className="mt-0"
									label={`Note on ${where}`}
									onChange={(value) => notes.set(index, value)}
									onDone={() => notes.onEdit(undefined)}
									placeholder="Note on this line…"
									value={note}
								/>
							</div>
						) : (
							note.trim() && (
								<button
									className="flex w-full cursor-pointer gap-1.5 border-y border-x-0 border-l-2 border-solid border-y-editor-group-border border-l-link bg-code py-1 pr-2 pl-1.5 text-left font-sans text-[11.5px] leading-normal text-foreground hover:bg-list-hover"
									data-testid="walkthrough-line-note"
									onClick={() => notes.onEdit(index)}
									title="Edit"
									type="button">
									<span className="shrink-0 pt-px text-[10px] uppercase tracking-wider text-link">
										You · {sign === "-" ? "old " : ""}L{numbers[index]}
									</span>
									<span className="min-w-0 whitespace-pre-wrap break-words">{note.trim()}</span>
								</button>
							)
						)}
					</Fragment>
				)
			})}
		</div>
	)
}
