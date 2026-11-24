import { useLayoutEffect, useRef, useState } from "react"
import { splitInlineCode } from "@/components/walkthrough/walkthroughUtils"
import { cn } from "@/lib/utils"

/** Line height of the text, so a clamp of N lines ends on a line. */
const LINE_HEIGHT = 1.45

/**
 * A warning from the host (a removal or a delete) that stays readable in a narrow card: `names` as
 * code, a gap between paragraphs, and past a few lines the rest behind Show details instead of a
 * wall of text.
 */
export function WarningText({ text, lines = 6, className }: { text: string; lines?: number; className?: string }) {
	const body = useRef<HTMLDivElement>(null)
	const [expanded, setExpanded] = useState(false)
	const [overflows, setOverflows] = useState(false)
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-measure whenever the text changes
	useLayoutEffect(() => {
		const element = body.current
		if (!element || expanded) return
		const measure = () => setOverflows(element.scrollHeight > element.clientHeight + 1)
		measure()
		const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure)
		observer?.observe(element)
		return () => observer?.disconnect()
	}, [text, expanded])
	return (
		<div className={cn("min-w-0", className)} style={{ lineHeight: LINE_HEIGHT }}>
			<div
				// Block, not flex: flex items would shrink to fit the clamp, and then nothing measures as hidden.
				className={cn("min-w-0 [&>p+p]:mt-1.5", !expanded && "overflow-hidden")}
				ref={body}
				style={expanded ? undefined : { maxHeight: `${lines * LINE_HEIGHT}em` }}>
				{text
					.split(/\n\s*\n/)
					.filter((paragraph) => paragraph.trim())
					.map((paragraph, index) => (
						<p className="m-0 whitespace-pre-line wrap-anywhere" key={index}>
							{splitInlineCode(paragraph.trim()).map((part, at) =>
								part.code ? (
									<code className="rounded-xs bg-code px-1 font-mono text-[0.92em]" key={at}>
										{part.text}
									</code>
								) : (
									<span key={at}>{part.text}</span>
								),
							)}
						</p>
					))}
			</div>
			{(overflows || expanded) && (
				<button
					aria-expanded={expanded}
					className="mt-0.5 cursor-pointer border-0 bg-transparent p-0 text-[11px] text-link hover:underline"
					onClick={() => setExpanded(!expanded)}
					type="button">
					{expanded ? "Show less" : "Show details"}
				</button>
			)}
		</div>
	)
}
