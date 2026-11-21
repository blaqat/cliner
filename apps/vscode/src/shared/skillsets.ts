// Skillsets: a `name.skillset.zip` of skills and workflows that one person
// saves and another drops on the Cline panel. Also the staged skill drafts the
// agent proposes ("make this a skill"), reviewed in the same row as notes.

export type SkillItemKind = "skill" | "workflow"

/** The file name suffix every skillset is saved with; a plain .zip is accepted too. */
export const SKILLSET_SUFFIX = ".skillset.zip"

/** How the receiver adds a set: the README in the zip and the sender's Copy how-to say the same. */
export const SKILLSET_HOW_TO =
	"To add it in VS Code: hold Shift and drop the file on the Cline panel, or open Rules & workflows › Skills › Add skillset…"

/** Webview drops are read in the webview and sent as bytes; bigger files must come from Add skillset… */
export const SKILLSET_MAX_DROP_BYTES = 20 * 1024 * 1024

/** One file inside a skill or workflow, as listed to the user. */
export interface SkillItemFile {
	/** Relative to the skill folder (`SKILL.md`, `scripts/run.sh`); a workflow has only its own file name. */
	path: string
	size: number
	/** A script or an executable: Cline can run it. */
	runsCode?: boolean
}

/** A skill or workflow that arrived from a skillset (or can be shared in one). */
export interface SkillsetItem {
	kind: SkillItemKind
	/** The skill's folder name or the workflow's file name without `.md`. */
	name: string
	description: string
	/** SKILL.md for a skill, the .md file for a workflow. */
	path: string
	isGlobal: boolean
	enabled: boolean
	files: SkillItemFile[]
	runsCode: boolean
	/** Files a shared set leaves out: dotfiles like .env, links, oversized files. */
	skippedFiles?: string[]
	/** Arrived in a set and not yet turned on or looked at. */
	isNew?: boolean
	/** Kept both on a name clash: the name of the one the user already had. */
	clashWith?: string
	/** The set it came from (an entry in the skillset registry). */
	setId?: string
}

/** A set that was added, so "Remove all from this set" works later. */
export interface InstalledSkillset {
	id: string
	name: string
	description?: string
	fileName: string
	addedAt: number
	items: SkillsetItem[]
}

/** What an import did, for the toast and the Skills tab's New strip. */
export interface SkillsetImportResult {
	/** The set as recorded; absent when nothing new arrived. */
	set?: InstalledSkillset
	fileName: string
	skills: number
	workflows: number
	/** Identical copies of things the user already had. */
	alreadyHad: number
	/** Why nothing arrived (not a skillset, unsafe, too big). */
	error?: string
	/** The user closed the open dialog. */
	cancelled?: boolean
}

/** Everything the Share page and the New strip need. */
export interface SkillsetLibrary {
	skills: SkillsetItem[]
	workflows: SkillsetItem[]
	sets: InstalledSkillset[]
	hasWorkspace: boolean
}

export interface SkillsetExportResult {
	cancelled?: boolean
	path?: string
	/** The folder it was saved in, with the home folder as ~. */
	folder?: string
	fileName?: string
	bytes?: number
	items?: number
	runsCode?: number
	/** Files left out (dotfiles like .env, oversized files). */
	skipped?: string[]
	/** The zip's layout, for the "Inside the zip" list. */
	layout?: string[]
}

/** The manifest at the root of a skillset zip. */
export interface SkillsetManifest {
	format: 1
	name: string
	description?: string
	createdWith?: string
	items: { kind: SkillItemKind; name: string; description?: string }[]
}

/**
 * A staged skill or workflow the agent proposed. It rides a NotebookChange
 * under SKILL_DRAFTS_ID: `content` is the SKILL.md (or workflow) body without
 * front matter, and these extra fields say what it is and where it goes.
 */
export interface SkillDraftMeta {
	kind: SkillItemKind
	scope: "global" | "workspace"
	/** Extra files for a skill (scripts, references), relative to the skill folder. */
	files?: { path: string; content: string }[]
	/** Editing an existing skill or workflow: its SKILL.md / .md path. */
	targetPath?: string
	/** The existing body the edit is diffed against. */
	baseContent?: string
	/** Exact bytes at staging time; null means the file did not exist. */
	baseFiles?: Record<string, string | null>
	/** Disk versions found on Keep, retained until the user chooses a version. */
	conflict?: Record<string, string | null>
}

/** The reserved notebook id staged skill drafts live under (like About you). */
export const SKILL_DRAFTS_ID = "skill-drafts"

/** True for a file Cline could run: scripts folders, script extensions, or an executable bit. */
export function looksRunnable(filePath: string, mode?: number): boolean {
	const normalized = filePath.replace(/\\/g, "/").toLowerCase()
	if (/(^|\/)(scripts|bin)\//.test(normalized)) return true
	if (/\.(sh|bash|zsh|fish|py|js|mjs|cjs|ts|mts|rb|pl|php|ps1|psm1|bat|cmd|exe|lua|go|jar)$/.test(normalized)) return true
	return mode !== undefined && (mode & 0o111) !== 0 && !normalized.endsWith(".md")
}

/** A safe skill or workflow name: lowercase words joined by dashes. */
export function slugifySkillName(name: string): string {
	return name
		.normalize("NFKD")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64)
}
