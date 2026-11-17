import type { NotebookDiffLine } from "@shared/task-groups"
import type { ChangeWalkthrough, WalkthroughHunk, WalkthroughStop } from "@shared/Walkthrough"

/** A hunk's unified patch as NotebookDiff lines, so walkthrough hunks look like the other +/− diffs. */
export function patchToDiffLines(patch: string): NotebookDiffLine[] {
	const lines: NotebookDiffLine[] = []
	for (const raw of patch.replace(/\n$/, "").split("\n")) {
		if (raw.startsWith("@@") || raw.startsWith("\\")) continue
		const kind = raw.startsWith("+") ? "add" : raw.startsWith("-") ? "remove" : "context"
		const text = raw.slice(1)
		const last = lines[lines.length - 1]
		if (last?.kind === kind) last.text += `\n${text}`
		else lines.push({ kind, text })
	}
	return lines
}

export function countChanges(patch: string): { added: number; removed: number } {
	let added = 0
	let removed = 0
	for (const line of patch.split("\n")) {
		if (line.startsWith("+")) added++
		else if (line.startsWith("-")) removed++
	}
	return { added, removed }
}

export interface StopFile {
	fileId: string
	path: string
	hunks: WalkthroughHunk[]
}

/** A stop's hunks grouped by file, in the stop's order. Unknown ids are skipped: the host already repaired them. */
export function stopFiles(walk: ChangeWalkthrough, stop: WalkthroughStop): StopFile[] {
	const byId = new Map(walk.hunks.map((hunk) => [hunk.id, hunk]))
	const files: StopFile[] = []
	for (const id of stop.hunkIds) {
		const hunk = byId.get(id)
		if (!hunk) continue
		const file = files.find((entry) => entry.fileId === hunk.fileId)
		if (file) file.hunks.push(hunk)
		else files.push({ fileId: hunk.fileId, path: hunk.path, hunks: [hunk] })
	}
	return files
}

/** Why a synthetic hunk has no diff or revert here. */
export function syntheticReason(hunk: WalkthroughHunk): string {
	return hunk.patch === "Binary file changed"
		? "Binary file: open the diff to compare; it can't be reverted here."
		: "Only file metadata changed: nothing to show or revert here."
}

/** Prose is plain text with inline code: odd segments between backticks are code. */
export function splitInlineCode(prose: string): { code: boolean; text: string }[] {
	return prose
		.split("`")
		.map((text, index) => ({ code: index % 2 === 1, text }))
		.filter((part) => part.text)
}

/** "bun.lock, 2 snapshots, README": the support section's collapsed summary of file names. */
export function supportSummary(walk: ChangeWalkthrough): string {
	const paths = [
		...new Set(walk.support.flatMap((stop) => stopFiles(walk, stop).map((file) => file.path.split("/").pop() ?? file.path))),
	]
	return paths.length > 4 ? `${paths.slice(0, 3).join(", ")} and ${paths.length - 3} more` : paths.join(", ")
}

/**
 * What is folded on one walkthrough. Chapters are keyed by id; hunks by their content fingerprint,
 * so a hunk stays folded when a refresh or revert reassigns its alias.
 */
export interface Folds {
	collapsedChapters: Record<string, boolean>
	collapsedHunks: Record<string, boolean>
	/** Support starts folded: it's lockfiles and mechanical changes. */
	supportOpen: boolean
}

export const EMPTY_FOLDS: Folds = { collapsedChapters: {}, collapsedHunks: {}, supportOpen: false }

/** Collapse all: every chapter, hunk and Support, so reopening a chapter shows its stops' prose first. */
export function foldAll(walk: ChangeWalkthrough): Folds {
	return {
		collapsedChapters: Object.fromEntries(walk.chapters.map((chapter) => [chapter.id, true])),
		collapsedHunks: Object.fromEntries(walk.hunks.map((hunk) => [hunk.fingerprint, true])),
		supportOpen: false,
	}
}

/** Expand all: every chapter and hunk. Support keeps its own toggle. */
export function unfoldAll(folds: Folds): Folds {
	return { collapsedChapters: {}, collapsedHunks: {}, supportOpen: folds.supportOpen }
}
