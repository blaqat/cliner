import type { NotebookDiffLine } from "@shared/task-groups"
import { useMemo, useState } from "react"
import { cn } from "@/lib/utils"
import { pairChangedLines } from "./wordDiff"

/**
 * A proposed change opened in a review row never takes over the chat: past about half
 * the window it scrolls on its own (the user asked for this cap, so it's the one nested
 * scroll region allowed there).
 */
export const PROPOSAL_BODY_CLASS = "max-h-[50vh] overflow-y-auto overscroll-contain"

const LINE_BACKGROUND = {
	add: "bg-[var(--vscode-diffEditor-insertedLineBackground,color-mix(in_srgb,var(--vscode-diffEditor-insertedTextBackground)_50%,transparent))]",
	remove: "bg-[var(--vscode-diffEditor-removedLineBackground,color-mix(in_srgb,var(--vscode-diffEditor-removedTextBackground)_50%,transparent))]",
}
const WORD_BACKGROUND = {
	add: "bg-(--vscode-diffEditor-insertedTextBackground)",
	remove: "bg-(--vscode-diffEditor-removedTextBackground)",
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`

/**
 * A line diff: each change with a few lines around it, the words a changed line
 * touched highlighted, and long unchanged runs folded to one "⋯ 40 unchanged lines"
 * row that opens in place. Long lines wrap, so the sidebar never scrolls sideways.
 */
export function NotebookDiff({ lines }: { lines: NotebookDiffLine[] }) {
	const [expanded, setExpanded] = useState<Set<number>>(new Set())
	const words = useMemo(() => pairChangedLines(lines), [lines])
	if (!lines.some((line) => line.kind === "add" || line.kind === "remove")) {
		return <p className="m-0 px-1 py-1 text-[11px] text-description">No changes to the text.</p>
	}
	return (
		<div
			aria-label="Changes"
			className="rounded-xs border border-solid border-editor-group-border bg-(--vscode-editor-background) py-0.5 font-mono text-[11px] leading-5"
			data-testid="notebook-diff"
			role="group">
			{lines.map((line, index) => {
				if (line.kind === "collapsed" && !expanded.has(index)) {
					const count = line.text.split("\n").length
					return (
						<button
							aria-label={`Show ${plural(count, "unchanged line")}`}
							className="flex w-full cursor-pointer items-center border-0 bg-transparent p-0 pr-2 font-[inherit] text-[11px] text-description hover:bg-list-hover hover:text-foreground focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-(--vscode-focusBorder)"
							key={index}
							onClick={() => setExpanded(new Set([...expanded, index]))}
							type="button">
							<span aria-hidden className="w-4 shrink-0 text-center">
								⋯
							</span>
							{plural(count, "unchanged line")}
						</button>
					)
				}
				const kind = line.kind === "add" || line.kind === "remove" ? line.kind : undefined
				const parts = words.get(index)
				return line.text.split("\n").map((text, row) => (
					<div
						className={cn("flex whitespace-pre-wrap break-words", kind && LINE_BACKGROUND[kind])}
						data-kind={line.kind === "collapsed" ? "context" : line.kind}
						key={`${index}-${row}`}>
						<span
							aria-hidden
							className={cn(
								"w-4 shrink-0 select-none text-center",
								kind === "add"
									? "text-(--vscode-gitDecoration-addedResourceForeground)"
									: kind === "remove"
										? "text-(--vscode-gitDecoration-deletedResourceForeground)"
										: "text-description",
							)}>
							{kind === "add" ? "+" : kind === "remove" ? "−" : ""}
						</span>
						<span className="min-w-0 flex-1 pr-2">
							{kind && <span className="sr-only">{kind === "add" ? "Added: " : "Removed: "}</span>}
							{parts && kind
								? parts.map((part, partIndex) =>
										part.changed ? (
											<mark
												className={cn("rounded-[2px] text-inherit", WORD_BACKGROUND[kind])}
												key={partIndex}>
												{part.text}
											</mark>
										) : (
											part.text
										),
									)
								: text || " "}
						</span>
					</div>
				))
			})}
		</div>
	)
}
