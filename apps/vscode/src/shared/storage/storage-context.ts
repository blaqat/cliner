import { randomUUID } from "node:crypto"
import fsSync from "node:fs"
import os from "node:os"
import path from "node:path"
import { name as extensionName } from "../../../package.json"
import { Logger } from "../services/Logger"
import { ClineFileStorage } from "./ClineFileStorage"
import { ClineMemento } from "./ClineStorage"

/**
 * The storage backend context object used by StateManager and other components.
 * Global, workspace and secret key-value storage goes through this component.
 *
 * This replaces the previous pattern of passing VSCode's ExtensionContext around
 * for storage access. All platforms (VSCode, CLI, JetBrains) use the same
 * file-backed implementation.
 */
export interface StorageContext {
	/** Global state — settings, task history references, UI state, etc. */
	readonly globalState: ClineMemento

	// TODO: Privatize this field after StorageContext becomes class with a reset method.
	/**
	 * The backing store for global state. Prefer `globalState` when possible.
	 *
	 * This split exists because CLI needs to intercept the ClineMemento interface to global state,
	 * but state resets need to write through to the backing store.
	 */
	readonly globalStateBackingStore: ClineFileStorage

	/** Secrets — API keys and other sensitive values. File uses restricted permissions (0o600). */
	readonly secrets: ClineFileStorage<string>

	/** Workspace-scoped state — per-project toggles, rules, etc. */
	readonly workspaceState: ClineFileStorage

	/** The resolved path to the data directory (~/.cline/data) */
	readonly dataDir: string

	/** Where this build's global state, secrets and workspace state live: see `resolveStateDirFromEnv`. */
	readonly stateDir: string

	/** The resolved path to the workspace storage directory (contains workspaceState.json) */
	readonly workspaceStoragePath: string
}

export interface StorageContextOptions {
	/**
	 * Override the Cline home directory. When set, the data directory is always
	 * `<clineDir>/data`. Defaults to env-based resolution: CLINE_DATA_DIR, then
	 * CLINE_DIR + "/data", then ~/.cline/data.
	 */
	clineDir?: string

	/**
	 * The workspace/project directory path. Used to compute a hash-based
	 * workspace storage subdirectory. Defaults to process.cwd().
	 */
	workspacePath?: string

	/**
	 * Explicit workspace storage directory override.
	 * When set, this path is used directly instead of computing a hash.
	 * Used by JetBrains (via WORKSPACE_STORAGE_DIR env var).
	 *
	 * TODO: Unify JetBrains workspace path scheme with the hash-based approach
	 * once the JetBrains client side is cleaned up.
	 */
	workspaceStorageDir?: string

	/** Keep state in this subfolder of the data directory. Defaults to `stateNamespace()`. */
	stateNamespace?: string
}

const SETTINGS_SUBFOLDER = "data"

/** Owner read/write only — protects API keys. */
const SECRETS_MODE = 0o600

/**
 * A renamed build installs beside the Marketplace extension, and both activate on startup. That
 * extension loads these JSON files once and writes its whole copy back on every save, so sharing
 * them undoes whatever this build saved since it started. The rest of the data directory (sessions,
 * task notebooks, MCP settings) isn't rewritten that way, and stays shared.
 */
export const stateNamespace = (): string | undefined => (extensionName === "claude-dev" ? undefined : extensionName)

/**
 * Create a short deterministic hash of a string for use in directory names.
 * Produces an up-to-8-character hex string.
 */
function hashString(str: string): string {
	let hash = 0
	for (let i = 0; i < str.length; i++) {
		const char = str.charCodeAt(i)
		hash = (hash << 5) - hash + char
		hash = hash & hash // Convert to 32-bit integer
	}
	return Math.abs(hash).toString(16).substring(0, 8)
}

/**
 * Resolve the Cline data directory from the environment:
 * CLINE_DATA_DIR (trimmed) > CLINE_DIR + "/data" > ~/.cline/data.
 *
 * Single source of truth shared by createStorageContext and the SDK adapter's
 * legacy-state-reader, matching the SDK's own resolveClineDataDir. Every
 * reader/writer of globalState.json, secrets.json, and providers.json must
 * resolve through the same rules — diverging resolvers split provider state
 * across directories, so requests can run on a provider the settings never
 * show (ENG-2332).
 */
export function resolveDataDirFromEnv(): string {
	const envDataDir = process.env.CLINE_DATA_DIR?.trim()
	if (envDataDir) {
		return envDataDir
	}
	const clineDir = process.env.CLINE_DIR?.trim() || path.join(os.homedir(), ".cline")
	return path.join(clineDir, SETTINGS_SUBFOLDER)
}

/** Where this build's own JSON stores live: the data directory, or its subfolder for a renamed build. */
export function resolveStateDirFromEnv(namespace = stateNamespace()): string {
	return namespace ? path.join(resolveDataDirFromEnv(), namespace) : resolveDataDirFromEnv()
}

/**
 * Starts a store from the shared one the first time, so nobody loses their setup moving over. Atomic
 * and never overwrites: windows starting together after a restart can't half-write or replace it.
 */
function adoptOnce(from: string, to: string, mode?: number): void {
	if (from === to || fsSync.existsSync(to) || !fsSync.existsSync(from)) return
	const staged = `${to}.adopt.${randomUUID()}`
	const alreadyThere = (error: unknown) => (error as NodeJS.ErrnoException).code === "EEXIST"
	try {
		fsSync.mkdirSync(path.dirname(to), { recursive: true })
		fsSync.copyFileSync(from, staged)
		if (mode !== undefined) fsSync.chmodSync(staged, mode)
		try {
			fsSync.linkSync(staged, to)
		} catch (error) {
			// A drive without hard links: not atomic, but still never overwrites.
			if (!alreadyThere(error)) fsSync.copyFileSync(staged, to, fsSync.constants.COPYFILE_EXCL)
		}
	} catch (error) {
		// Starting without the old setup beats not starting; it's tried again until this build saves.
		if (!alreadyThere(error)) Logger.error(`[StorageContext] Couldn't copy ${from} to ${to}:`, error)
	} finally {
		fsSync.rmSync(staged, { force: true })
	}
}

/**
 * Creates a StorageContext backed by JSON files on disk.
 *
 * All path computation is contained here — callers should not
 * construct paths to these storage files themselves.
 *
 * File layout (under the resolved data directory, ~/.cline/data by default):
 *   <dataDir>/globalState.json    — global state
 *   <dataDir>/secrets.json        — secrets (mode 0o600)
 *   <dataDir>/workspaces/<hash>/workspaceState.json — per-workspace state
 *
 * A renamed build keeps these under <dataDir>/<name>/ instead (see `stateNamespace`).
 *
 * @param opts Configuration options for path resolution
 * @returns A StorageContext ready for use by StateManager
 */
export function createStorageContext(opts: StorageContextOptions = {}): StorageContext {
	const dataDir = opts.clineDir ? path.join(opts.clineDir, SETTINGS_SUBFOLDER) : resolveDataDirFromEnv()
	const namespace = "stateNamespace" in opts ? opts.stateNamespace : stateNamespace()
	const stateDir = namespace ? path.join(dataDir, namespace) : dataDir

	// Resolve workspace storage directory
	let workspaceDir: string
	if (opts.workspaceStorageDir) {
		// Explicit override (JetBrains via env var, or test overrides)
		workspaceDir = opts.workspaceStorageDir
	} else {
		// Hash-based workspace isolation (CLI, VSCode)
		const workspacePath = opts.workspacePath || process.cwd()
		const workspaceHash = hashString(workspacePath)
		workspaceDir = path.join(stateDir, "workspaces", workspaceHash)
		adoptOnce(
			path.join(dataDir, "workspaces", workspaceHash, "workspaceState.json"),
			path.join(workspaceDir, "workspaceState.json"),
		)
	}

	// Ensure directories exist
	fsSync.mkdirSync(stateDir, { recursive: true })
	fsSync.mkdirSync(workspaceDir, { recursive: true })
	adoptOnce(path.join(dataDir, "globalState.json"), path.join(stateDir, "globalState.json"))
	adoptOnce(path.join(dataDir, "secrets.json"), path.join(stateDir, "secrets.json"), SECRETS_MODE)

	const globalState = new ClineFileStorage(path.join(stateDir, "globalState.json"), "GlobalState")

	return {
		globalState,
		globalStateBackingStore: globalState,
		secrets: new ClineFileStorage<string>(path.join(stateDir, "secrets.json"), "Secrets", {
			fileMode: SECRETS_MODE,
		}),
		workspaceState: new ClineFileStorage(path.join(workspaceDir, "workspaceState.json"), "WorkspaceState"),
		dataDir,
		stateDir,
		workspaceStoragePath: workspaceDir,
	}
}
