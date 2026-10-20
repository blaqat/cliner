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
	overallNote?: string
	/** With scope "authored": which stored walkthrough. */
	authoredId?: string
}
