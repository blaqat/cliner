export type WorktreeMode = "off" | "git" | "mm"
export interface ThreadWorktreeSettings {
	mode: WorktreeMode
	mmPath: string
	nodePath: string
}
export interface WorktreeModule {
	name: string
	workspacePath: string
	path: string
	base: string
	lastBroughtTree?: string
}
export interface ThreadWorktree {
	threadId: string
	mode: "git" | "mm"
	branch: string
	workspace: string
	cwd: string
	modules: WorktreeModule[]
	createdAt: number
	/** The exact diff last brought in or taken over, not just a boolean. */
	takenOver?: boolean
	transferredDiff?: string
	bringIns: {
		id: string
		patches: { module: string; file: string; applied: boolean; undone?: boolean; previousTree?: string; tree?: string }[]
	}[]
}
export interface ThreadModuleDiff {
	module: string
	workspacePath: string
	worktreePath: string
	base: string
	/** Unified binary-capable git patch, with paths relative to this module. */
	tree?: string
	patch: string
	/** Paths for display/checkpoints, prefixed with the module for mm. */
	paths: string[]
}
export interface WorktreeAvailability {
	mode: WorktreeMode
	available: boolean
	reason?: string
	workspaceOff: boolean
	hasMmrc: boolean
}
export interface WorktreeState {
	settings: ThreadWorktreeSettings
	availability: WorktreeAvailability
	mapping?: ThreadWorktree
	settled: ThreadWorktree[]
}
/**
 * Where a worktree thread's changes stand, for the workspace menu: its status line and which
 * actions it lists (only the ones that apply).
 */
export interface WorktreeSummary {
	/** Files the thread changed since it started, committed or not. */
	changedFiles: number
	/** Commits on the thread's branch since it started. */
	commits: number
	/** Files changed in the worktree that aren't committed. */
	uncommittedFiles: number
	/** Files Copy changes here would bring (changed since the last copy, or since the start). */
	uncopiedFiles: number
	/** Something was copied into the workspace before (and not undone). */
	copied: boolean
	/** A copy that can still be undone. */
	canUndo: boolean
	/** Files a removal would throw away (never copied or switched to); 0 removes without asking. */
	loseOnRemove: number
	/** The workspace has uncommitted changes of its own, which blocks switching it to the branch. */
	workspaceDirty: boolean
	/** The workspace is on the thread's branch now; the worktree folder is a leftover. */
	takenOver: boolean
	/** The thread is running, which blocks copying, switching and removing. */
	running?: boolean
}
export interface WorktreeActionResult {
	state?: WorktreeState
	mapping?: ThreadWorktree
	diffs?: ThreadModuleDiff[]
	summary?: WorktreeSummary
	warning?: string
	conflicts?: string[]
	message?: string
	/** Files the action copied or carried along. */
	files?: number
}
