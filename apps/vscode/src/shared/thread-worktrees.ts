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
export interface WorktreeActionResult {
	state?: WorktreeState
	mapping?: ThreadWorktree
	diffs?: ThreadModuleDiff[]
	warning?: string
	conflicts?: string[]
	message?: string
}
