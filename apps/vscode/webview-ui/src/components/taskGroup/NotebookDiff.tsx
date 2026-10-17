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
						className="block w-full cursor-pointer border-0 bg-code text-description hover:text-link"
						key={index}
						onClick={() => setExpanded(new Set([...expanded, index]))}
						type="button">
						⋯ {line.text.split("\n").length} lines
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
