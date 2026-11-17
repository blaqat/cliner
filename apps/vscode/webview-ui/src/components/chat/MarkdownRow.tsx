import { memo } from "react"
import { cn } from "@/lib/utils"
import MarkdownBlock from "../common/MarkdownBlock"

export const MarkdownRow = memo(
	({ markdown, showCursor, streaming }: { markdown?: string; showCursor?: boolean; streaming?: boolean }) => {
		return (
			<div className={cn("wrap-anywhere overflow-hidden [&_p]:mb-0", streaming && "streaming-dot")}>
				<MarkdownBlock markdown={markdown} showCursor={showCursor} />
			</div>
		)
	},
)

MarkdownRow.displayName = "MarkdownRow"
