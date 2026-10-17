export type WalkthroughScope = "thread" | "last_turn" | "git"

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
}

export interface WalkthroughStop {
	id: string
	title: string
	prose: string
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
	source: "fallback" | "generated"
	title: string
	focus: string
	chapters: WalkthroughChapter[]
	support: WalkthroughStop[]
	hunks: WalkthroughHunk[]
	warnings: string[]
	profileId?: string
	cacheHit?: boolean
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
}
