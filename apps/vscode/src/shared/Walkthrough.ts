export type WalkthroughScope = "thread" | "last_turn" | "git" | "authored"

export interface WalkthroughHunk {
	id: string
	fingerprint: string
	fileId: string
	path: string
	header: string
	patch: string
	oldStart: number
	newStart: number
	turnId?: string
	synthetic?: boolean
	/** Authored walkthroughs: the hunk came from the agent (e.g. a merge request), not a local file. No open-diff or revert. */
	external?: boolean
}

export interface WalkthroughStop {
	id: string
	title: string
	prose: string
	/** Free layout only: the turn's full narration behind "Show more". */
	detail?: string
	hunkIds: string[]
	turnId?: string
}

export interface WalkthroughChapter {
	id: string
	title: string
	stops: WalkthroughStop[]
}

/**
 * A short note shown inside a hunk's diff, above the line it explains, to break a long change
 * into readable pieces. "turn" quotes what the agent said right before making that edit (free);
 * "why" is written by Generate.
 */
export interface WalkthroughAnnotation {
	hunkId: string
	/** Index into the hunk's body lines (see hunkBodyLines) the note sits above. */
	line: number
	text: string
	kind: "turn" | "why"
	/** "turn" notes: the turn that made the edit, e.g. "turn3". */
	turnId?: string
}

/** A reviewer's note on one line of a hunk (the line is an index into hunkBodyLines). */
export interface WalkthroughLineNote {
	hunkId: string
	line: number
	note: string
}

/** A hunk patch's lines after its `@@` header, without "\ No newline" markers: what annotations and line notes index. */
export function hunkBodyLines(patch: string): string[] {
	return patch
		.replace(/\n$/, "")
		.split("\n")
		.filter((line) => !line.startsWith("@@") && !line.startsWith("\\"))
}

/** The file line number a body line shows: the new file's for added and unchanged lines, the old file's for removed ones. */
export function hunkLineNumbers(hunk: Pick<WalkthroughHunk, "patch" | "oldStart" | "newStart">): number[] {
	let oldLine = hunk.oldStart
	let newLine = hunk.newStart
	return hunkBodyLines(hunk.patch).map((line) => {
		if (line.startsWith("+")) return newLine++
		if (line.startsWith("-")) return oldLine++
		oldLine++
		return newLine++
	})
}

export interface ChangeWalkthrough {
	version: 1
	taskId: string
	scope: WalkthroughScope
	fingerprint: string
	source: "fallback" | "generated" | "authored"
	title: string
	focus: string
	chapters: WalkthroughChapter[]
	support: WalkthroughStop[]
	hunks: WalkthroughHunk[]
	/** Notes inside the diff (see WalkthroughAnnotation). */
	annotations?: WalkthroughAnnotation[]
	warnings: string[]
	profileId?: string
	cacheHit?: boolean
	/** Authored walkthroughs only: the stored document's id within the thread. */
	authoredId?: string
	/** Authored walkthroughs only: where the change lives, e.g. { label: "GitLab MR !128", url }. */
	origin?: WalkthroughOrigin
}

export interface WalkthroughOrigin {
	label: string
	url?: string
}

/**
 * Input of the agent's `present_walkthrough` tool: a walkthrough the agent authored
 * from changes that aren't local (e.g. someone's merge request fetched over MCP).
 * Each hunk patch is unified-diff text (a hunk starting with "@@", or a file diff).
 */
export interface AuthoredWalkthroughInput {
	title: string
	focus?: string
	origin?: WalkthroughOrigin
	chapters: Array<{
		title: string
		stops: Array<{
			title: string
			prose: string
			hunks: Array<{ path: string; patch: string }>
		}>
	}>
}

/** Payload of the `walkthrough_ready` chat row (JSON in ClineMessage.text). */
export interface WalkthroughReadyMessage {
	authoredId: string
	title: string
	origin?: WalkthroughOrigin
	stopCount: number
	fileCount: number
}

export interface WalkthroughNotes {
	stopNotes: Record<string, string>
	lineNotes?: WalkthroughLineNote[]
	overallNote?: string
}

/** JSON payloads for TaskService's walkthrough RPCs. No file content from the webview is trusted. */
export interface WalkthroughRequest {
	taskId: string
	scope: WalkthroughScope
	profileId?: string
	regenerate?: boolean
	fingerprint?: string
	fileId?: string
	hunkId?: string
	confirmed?: boolean
	stopNotes?: Record<string, string>
	lineNotes?: WalkthroughLineNote[]
	overallNote?: string
	/** With scope "authored": which stored walkthrough. */
	authoredId?: string
}
