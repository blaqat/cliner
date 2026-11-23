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
	/** Gitlink paths intentionally left without a checkout when the worktree was created. */
	unsetSubmodules?: string[]
	/** The exact diff last brought in or taken over, not just a boolean. */
	takenOver?: boolean
	transferredDiff?: string
	/** Snapshots for descendant repositories, whose HEADs need not be on the thread branch. */
	repositoryCopies?: Record<string, { tree: string; head?: string }>
	leftoverState?: string
	bringIns: {
		id: string
		patches: {
			module: string
			file: string
			applied: boolean
			undone?: boolean
			previousTree?: string
			tree?: string
			workspacePath?: string
			head?: string
			previousHead?: string
			previousBranch?: string
			previousBroughtHead?: string
		}[]
	}[]
}
export interface ThreadModuleDiff {
	module: string
	workspacePath: string
	worktreePath: string
	base: string
	/** Descendant checkout HEAD and its original or last copied commit. */
	head?: string
	baseHead?: string
	/** Unified binary-capable git patch, with paths relative to this module. */
	tree?: string
	patch: string
	/** Paths for display/checkpoints, prefixed with the module for mm. */
	paths: string[]
}
/**
 * What to change so a worktree can be made: the Mode, this workspace's switch, the mm paths (or
 * mm's own config), or the folder's git (not a repository, no commits yet).
 */
export type WorktreeFix = "mode" | "workspace" | "mm" | "repository" | "commit"

export const WORKTREES_OFF = "Worktrees are off. Choose Git worktree or mm."
export const WORKTREES_OFF_HERE = "Worktrees are off for this workspace. Turn on Use worktrees in this workspace."
export const NOT_A_REPOSITORY = "This folder is not a git repository. Initialize git here or open the repository's folder."
export const NO_COMMITS = "This repository does not have any commits yet. Make a first commit."

/**
 * Where a worktree reason is fixed. Reasons are also stored as text (a thread that couldn't start,
 * automation runs), so this reads the words; the host's messages above keep these phrases.
 */
export function worktreeFixFor(reason: string | undefined): WorktreeFix | undefined {
	const text = reason ?? ""
	if (/worktrees are off for this workspace/i.test(text)) return "workspace"
	if (/worktrees are off/i.test(text)) return "mode"
	if (/mm\.js|node path:/i.test(text)) return "mm"
	if (/not a git repository/i.test(text)) return "repository"
	if (/does not have any commits|unknown revision|needed a single revision|ambiguous argument 'HEAD'/i.test(text))
		return "commit"
	return undefined
}

export interface WorktreeAvailability {
	mode: WorktreeMode
	available: boolean
	reason?: string
	/** Set when not available and the reason has a known fix. */
	fix?: WorktreeFix
	workspaceOff: boolean
	/** mm module names, when this folder is an mm workspace that's ready. */
	modules?: string[]
	mmCwd?: string
	mmConfigPath?: string
}
export interface WorktreeState {
	settings: ThreadWorktreeSettings
	availability: WorktreeAvailability
	mapping?: ThreadWorktree
	settled: ThreadWorktree[]
	/**
	 * `.mm.json` or `.mmrc` when the open folder has one at its root: only a hint to suggest mm.
	 * Modules always come from `mm modules --json`.
	 */
	mmConfigFile?: string
	/** Whether mm.js is at the set path; undefined when no path is set. */
	mmFound?: boolean
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
