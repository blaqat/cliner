import type { NotebookDiffLine } from "@shared/task-groups"
import { useMemo, useState } from "react"
import MarkdownBlock from "@/components/common/MarkdownBlock"
import { cn } from "@/lib/utils"
import { addedLineNumbers, noteBlocks, noteSections } from "./noteBlocks"

/** Notes longer than this fold their untouched sections to one line each. */
const FOLD_OVER_LINES = 24

/**
 * A note rendered as a page with the lines a change adds marked in the
 * inserted-text color, instead of a raw diff. Long notes fold the sections the
 * change didn't touch ("Flow · 14 lines"), one click to open.
 */
export function MarkedNote({ content, diff, markAll }: { content: string; diff: NotebookDiffLine[]; markAll?: boolean }) {
	const sections = useMemo(() => {
		const added = addedLineNumbers(diff)
		return noteSections(noteBlocks(content, added))
	}, [content, diff])
	const total = sections.reduce((sum, section) => sum + section.lines, 0)
	const [opened, setOpened] = useState<Set<number>>(new Set())
	const fold = total > FOLD_OVER_LINES && !markAll
	return (
		<div className="flex flex-col" data-testid="marked-note">
			{sections.map((section, index) =>
				fold && !section.marked && !opened.has(index) ? (
					<button
						className="my-0.5 flex w-full cursor-pointer items-center gap-1 rounded-xs border-0 bg-transparent px-1 py-0.5 text-left font-[inherit] text-[11px] text-description hover:bg-list-hover hover:text-foreground"
						key={index}
						onClick={() => setOpened((current) => new Set(current).add(index))}
						type="button">
						<span aria-hidden className="codicon codicon-fold-down text-[11px]!" />
						{section.heading ?? "Start"} · {section.lines} {section.lines === 1 ? "line" : "lines"}
					</button>
				) : (
					section.blocks.map((block, blockIndex) => (
						<div
							className={cn(
								"min-w-0 border-0 border-l-2 border-solid border-transparent pl-2 [&_.inline-markdown-block_p:last-child]:mb-1",
								(block.marked || markAll) &&
									"border-(--vscode-gitDecoration-addedResourceForeground) bg-(--vscode-diffEditor-insertedTextBackground)",
							)}
							data-marked={block.marked || markAll || undefined}
							key={`${index}-${blockIndex}`}>
							<MarkdownBlock markdown={block.raw} />
						</div>
					))
				),
			)}
		</div>
	)
}
