import { memo, useState } from "react"
import { CopyButton } from "./CopyButton"
import { getTextPreview } from "./text-preview"

/** Paging replaces the visible section rather than mounting an ever-growing row. */
export const LargeTextPreview = memo(({ source }: { source: string }) => {
	const [starts, setStarts] = useState([0])
	// A row can be reused for a shorter message; keep the current section valid.
	const start = starts.at(-1)! < source.length ? starts.at(-1)! : 0
	const preview = getTextPreview(source, start)
	return (
		<div className="text-description">
			<pre className="font-mono whitespace-pre-wrap break-all max-h-80 overflow-auto text-editor-foreground">
				{preview.text}
			</pre>
			<div className="flex items-center gap-2 text-xs">
				<span>Large content. Showing one section at a time.</span>
				{start > 0 && (
					<button className="text-link" onClick={() => setStarts((previous) => previous.slice(0, -1))} type="button">
						Previous section
					</button>
				)}
				{preview.truncated && (
					<button
						className="text-link"
						onClick={() => setStarts((previous) => [...previous, preview.end])}
						type="button">
						Show next section
					</button>
				)}
				<CopyButton ariaLabel="Copy full content" textToCopy={source} />
			</div>
		</div>
	)
})
