import { promises as fs } from "node:fs"
import path from "node:path"
import { resolveClineDir } from "@cline/shared/storage"
import { parseScriptFile, type ScriptDefinition, type ScriptScope } from "./script-file"
import { ScriptTrustStore, scriptFingerprint } from "./script-trust"

/** Workspace scripts sit next to the workspace workflows (`.clinerules/workflows`). */
export const WORKSPACE_SCRIPTS_DIR = path.join(".clinerules", "scripts")

/** Global scripts: `~/.cline/scripts/` (redirected by `CLINE_DIR` / `setClineDir`, so tests never touch the real one). */
export function globalScriptsDir(): string {
	return path.join(resolveClineDir(), "scripts")
}

export function workspaceScriptsDir(workspaceRoot: string): string {
	return path.join(workspaceRoot, WORKSPACE_SCRIPTS_DIR)
}

export interface LoadedScript {
	filePath: string
	scope: ScriptScope
	name: string
	description: string
	enabled: boolean
	trusted?: boolean
	fingerprint?: string
	command?: string
	cwd?: string
	/** Validation errors; the script is listed but never offered to the agent. */
	errors: string[]
	/** Present when the file is valid. */
	script?: ScriptDefinition
}

export interface ScriptToggles {
	global: Record<string, boolean>
	workspace: Record<string, boolean>
}

/**
 * Module names from `.mmrc`, searching upward from `startDir` like `mm` does.
 * The file is either JSON (`{ "modules": [...] }` or a bare array whose entries are
 * paths or `{ path, name }`) or one module path per line with `#` comments.
 */
export async function readMmrcModules(startDir: string): Promise<string[]> {
	let dir = path.resolve(startDir)
	for (;;) {
		try {
			const raw = await fs.readFile(path.join(dir, ".mmrc"), "utf8")
			return parseMmrcModules(raw)
		} catch {
			const parent = path.dirname(dir)
			if (parent === dir) return []
			dir = parent
		}
	}
}

export function parseMmrcModules(raw: string): string[] {
	let entries: unknown[]
	const trimmed = raw.trimStart()
	if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
		try {
			const parsed = JSON.parse(raw) as unknown
			const list = Array.isArray(parsed) ? parsed : (parsed as { modules?: unknown })?.modules
			entries = Array.isArray(list) ? list : []
		} catch {
			return []
		}
	} else {
		entries = raw
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line && !line.startsWith("#"))
	}
	const names: string[] = []
	for (const entry of entries) {
		const modulePath = typeof entry === "string" ? entry : (entry as { path?: string })?.path
		const explicit = typeof entry === "object" && entry !== null ? (entry as { name?: string }).name : undefined
		const name = explicit || (modulePath ? path.basename(modulePath.replace(/[\\/]+$/, "")) : "")
		if (name && !names.includes(name)) names.push(name)
	}
	return names
}

async function readScriptDirectory(dir: string, scope: ScriptScope, toggles: Record<string, boolean>): Promise<LoadedScript[]> {
	let entries: string[]
	try {
		entries = await fs.readdir(dir)
	} catch {
		return []
	}
	const loaded: LoadedScript[] = []
	for (const entry of entries.filter((file) => file.toLowerCase().endsWith(".md")).sort()) {
		const filePath = path.join(dir, entry)
		let content: string
		try {
			content = await fs.readFile(filePath, "utf8")
		} catch {
			continue
		}
		const parsed = parseScriptFile(content, { filePath, scope, fallbackName: entry.replace(/\.md$/i, "") })
		loaded.push({
			filePath,
			scope,
			name: parsed.name,
			description: parsed.description,
			enabled: toggles[filePath] !== false,
			errors: parsed.errors,
			script: parsed.script,
		})
	}
	return loaded
}

export interface ScriptStoreDeps {
	getTrustFile?: () => string
	getGlobalDir?: () => string
	getWorkspaceRoot: () => string | undefined
	getToggles: () => ScriptToggles
}

/** Reads script files from the global and workspace folders and applies the on/off toggles. */
export class ScriptStore {
	private cachedEnabled: ScriptDefinition[] = []
	private refreshedAt = 0
	private refreshing = false

	readonly trust: ScriptTrustStore
	constructor(private readonly deps: ScriptStoreDeps) {
		this.trust = new ScriptTrustStore(deps.getTrustFile)
	}

	/** Every script file, valid or not, workspace first. */
	async list(): Promise<LoadedScript[]> {
		const toggles = this.deps.getToggles()
		const root = this.deps.getWorkspaceRoot()
		const [workspace, global] = await Promise.all([
			root ? readScriptDirectory(workspaceScriptsDir(root), "workspace", toggles.workspace) : [],
			readScriptDirectory((this.deps.getGlobalDir ?? globalScriptsDir)(), "global", toggles.global),
		])
		const all = [...workspace, ...global]
		const mmrcModules = all.some((item) => item.script?.options.some((option) => option.choicesFrom === "mmrc"))
			? await readMmrcModules(root ?? process.cwd())
			: []
		for (const item of all) {
			for (const option of item.script?.options ?? []) {
				if (option.choicesFrom === "mmrc") option.choices = [...mmrcModules]
			}
		}
		for (const item of all) {
			if (item.script) {
				item.trusted = await this.trust.isTrusted(item.script)
				item.fingerprint = scriptFingerprint(item.script)
				item.command = item.script.command
				item.cwd = item.script.cwd ?? root ?? process.cwd()
			}
		}
		this.cachedEnabled = this.pickEnabled(all)
		this.refreshedAt = Date.now()
		return all
	}

	/** Enabled, valid scripts; a workspace script shadows a global one of the same name. */
	private pickEnabled(all: LoadedScript[]): ScriptDefinition[] {
		const byName = new Map<string, ScriptDefinition>()
		for (const item of all) {
			if (item.enabled && item.script && !byName.has(item.script.name)) byName.set(item.script.name, item.script)
		}
		return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
	}

	async listEnabled(): Promise<ScriptDefinition[]> {
		await this.list()
		return this.cachedEnabled
	}

	async find(name: string): Promise<ScriptDefinition | undefined> {
		return (await this.listEnabled()).find((script) => script.name === name)
	}

	/** Last loaded enabled scripts, for synchronous prompt text; reload when older than `maxAgeMs`. */
	peekEnabled(maxAgeMs = 3000): ScriptDefinition[] {
		if (!this.refreshing && Date.now() - this.refreshedAt > maxAgeMs) {
			this.refreshing = true
			void this.list()
				.catch(() => {})
				.finally(() => {
					this.refreshing = false
				})
		}
		return this.cachedEnabled
	}
}
