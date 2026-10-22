import type { NotebookDiffLine } from "@shared/task-groups"
import { useState } from "react"

export function NotebookDiff({ lines }: { lines: NotebookDiffLine[] }) {
	const [expanded, setExpanded] = useState<Set<number>>(new Set())
	return (
		<div
			aria-label="Unified note diff"
			className="overflow-x-auto rounded-xs border border-editor-group-border font-mono text-[11px] leading-5">
			{lines.map((line, index) =>
				line.kind === "collapsed" && !expanded.has(index) ? (
					<button
						aria-label={`Show ${line.text.split("\n").length} unchanged lines`}
						className="flex w-full cursor-pointer items-center justify-center gap-1 border-0 bg-code py-0.5 text-description hover:bg-list-hover hover:text-foreground"
						key={index}
						onClick={() => setExpanded(new Set([...expanded, index]))}
						type="button">
						<span aria-hidden className="codicon codicon-unfold text-[11px]!" />
						{line.text.split("\n").length} lines
					</button>
				) : (
					<pre
						className="m-0 px-2 whitespace-pre"
						key={index}
						style={{
							background:
								line.kind === "add"
									? "var(--vscode-diffEditor-insertedTextBackground)"
									: line.kind === "remove"
										? "var(--vscode-diffEditor-removedTextBackground)"
										: undefined,
						}}>
						{line.text.split("\n").map((text, i) => (
							<div key={i}>
								{line.kind === "add" ? "+" : line.kind === "remove" ? "−" : " "}
								{text || " "}
							</div>
						))}
					</pre>
				),
			)}
		</div>
	)
}
