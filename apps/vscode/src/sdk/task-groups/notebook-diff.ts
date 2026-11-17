import type { NotebookDiffLine } from "@shared/task-groups"
import { diffLines } from "diff"

/** Keep two unchanged lines beside each change. Hidden runs retain their text for expansion. */
export function notebookDiff(before: string, after: string, context = 2): NotebookDiffLine[] {
	const lines = diffLines(before, after).flatMap((part) => {
		const text = part.value.replace(/\n$/, "")
		return text.split("\n").map((text) => ({
			kind: part.added ? ("add" as const) : part.removed ? ("remove" as const) : ("context" as const),
			text,
		}))
	})
	const visible = new Set<number>()
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].kind === "context") continue
		for (let index = i - context; index <= i + context; index++) visible.add(index)
	}
	const result: NotebookDiffLine[] = []
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]
		if (line.kind !== "context" || visible.has(i)) result.push(line)
		else {
			const last = result[result.length - 1]
			if (last?.kind === "collapsed") last.text += `\n${line.text}`
			else result.push({ kind: "collapsed", text: line.text })
		}
	}
	return result
}

export function compactNotebookDiff(before: string, after: string): string {
	return notebookDiff(before, after)
		.map((line) =>
			line.kind === "collapsed"
				? `… ${line.text.split("\n").length} lines`
				: `${line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " "}${line.text}`,
		)
		.join("\n")
		.slice(0, 4000)
}
