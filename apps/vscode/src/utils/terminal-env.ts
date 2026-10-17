import type { TerminalEnvironmentSettings, TerminalEnvironmentSource } from "@shared/terminal-environment"
import { promises as fs } from "fs"
import * as os from "os"
import * as path from "path"

/**
 * Merges the configured terminal environment for commands Cline runs.
 *
 * Layer order, lowest to highest precedence:
 *   process env -> global .env file -> workspace .env file -> global
 *   variables -> workspace variables -> PATH prepends
 * .env files are read at merge time and never stored or reported back; only
 * variable *names* and their winning source are exposed for the settings
 * preview — values stay local and are never logged.
 */

export interface ResolvedTerminalEnv {
	/**
	 * Everything Cline adds on top of the base env: .env vars, configured
	 * variables, and a rewritten PATH. Pass this as the `env` option when
	 * creating terminals or spawning background commands.
	 */
	overrides: Record<string, string>
	/** Full environment a spawned command sees (base env + overrides). */
	env: Record<string, string>
	/**
	 * Name -> source for variables set above the base env. `overridden` is the
	 * losing source when a higher-precedence scope set the same name.
	 */
	sources: Record<string, { source: TerminalEnvironmentSource; overridden?: TerminalEnvironmentSource }>
}

export interface TerminalEnvResolveOptions {
	global?: TerminalEnvironmentSettings
	workspace?: TerminalEnvironmentSettings
	/** Defaults to process.env. */
	baseEnv?: NodeJS.ProcessEnv
	/**
	 * Stable base for relative workspace-scope .env paths: the workspace root,
	 * not the directory a particular command runs in. Falls back to `cwd`.
	 */
	workspaceRoot?: string
	/** Fallback base when `workspaceRoot` is not given. Defaults to process.cwd(). */
	cwd?: string
}

/** Minimal dotenv parser: KEY=value lines, `export` prefix, quotes, comments. */
export function parseEnvFile(content: string): Record<string, string> {
	const vars: Record<string, string> = {}
	for (const rawLine of content.split(/\r?\n/)) {
		const line = rawLine.trim()
		if (!line || line.startsWith("#")) continue
		const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
		if (!match) continue
		let value = match[2]
		if (value.length >= 2) {
			const quote = value[0]
			if ((quote === '"' || quote === "'") && value.endsWith(quote)) {
				value = value.slice(1, -1)
			}
		}
		vars[match[1]] = value
	}
	return vars
}

/**
 * Where a configured .env path points. Workspace-scope paths may be relative
 * to the workspace root; global-scope paths must be absolute or `~`-relative
 * (a relative global path has no stable base, so it resolves to nothing).
 * The settings preview and command execution both go through this.
 */
export function resolveEnvFilePath(
	filePath: string | undefined,
	scope: "global" | "workspace",
	workspaceRoot: string,
): string | undefined {
	const value = filePath?.trim()
	if (!value) return undefined
	if (value === "~" || value.startsWith("~/") || value.startsWith("~\\")) {
		return path.join(os.homedir(), value.slice(1))
	}
	if (path.isAbsolute(value)) return value
	if (scope === "global") return undefined
	return path.resolve(workspaceRoot, value)
}

async function readEnvFile(
	filePath: string | undefined,
	scope: "global" | "workspace",
	workspaceRoot: string,
	layers: Array<{ vars: Record<string, string>; source: TerminalEnvironmentSource }>,
): Promise<void> {
	const resolved = resolveEnvFilePath(filePath, scope, workspaceRoot)
	if (!resolved) return
	try {
		layers.push({ vars: parseEnvFile(await fs.readFile(resolved, "utf8")), source: "env_file" })
	} catch {
		// Missing/unreadable .env files are non-fatal: commands still run with
		// the remaining layers, and the path stays visible in settings.
	}
}

/** Structural subset of StateManager — keeps this helper free of the store. */
export interface TerminalEnvStore {
	getGlobalStateKey(key: "terminalEnvironment"): TerminalEnvironmentSettings | undefined
	getWorkspaceStateKey(key: "terminalEnvironment"): TerminalEnvironmentSettings | undefined
}

export async function resolveTerminalEnv(options: TerminalEnvResolveOptions): Promise<ResolvedTerminalEnv> {
	const baseEnv = options.baseEnv ?? process.env
	const workspaceRoot = options.workspaceRoot ?? options.cwd ?? process.cwd()
	const layers: Array<{ vars: Record<string, string>; source: TerminalEnvironmentSource }> = [
		{ vars: baseEnv as Record<string, string>, source: "process" },
	]
	await readEnvFile(options.global?.envFilePath, "global", workspaceRoot, layers)
	await readEnvFile(options.workspace?.envFilePath, "workspace", workspaceRoot, layers)
	if (options.global?.variables) layers.push({ vars: options.global.variables, source: "global" })
	if (options.workspace?.variables) layers.push({ vars: options.workspace.variables, source: "workspace" })

	const merged: Record<string, string> = {}
	const overrides: Record<string, string> = {}
	const sources: ResolvedTerminalEnv["sources"] = {}
	for (const layer of layers) {
		for (const [name, value] of Object.entries(layer.vars)) {
			if (value === undefined) continue
			if (layer.source !== "process") {
				const previous = layers
					.slice(0, layers.indexOf(layer))
					.reverse()
					.find((l) => l.vars[name] !== undefined)?.source
				sources[name] =
					previous && previous !== "process" ? { source: layer.source, overridden: previous } : { source: layer.source }
				overrides[name] = value
			}
			merged[name] = value
		}
	}

	// PATH additions prepend over the merged PATH; workspace entries win by
	// coming first. Skip the rewrite entirely when nothing is added.
	const pathKey = "PATH"
	const pathEntries = [...(options.workspace?.pathEntries ?? []), ...(options.global?.pathEntries ?? [])]
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0)
	if (pathEntries.length > 0) {
		const current = merged[pathKey] ?? merged.Path ?? ""
		merged[pathKey] = pathEntries.join(path.delimiter) + path.delimiter + current
		overrides[pathKey] = merged[pathKey]
	}

	return { overrides, env: merged, sources }
}

/** Read both stored scopes and merge the effective terminal environment. */
export function resolveConfiguredTerminalEnv(
	store: TerminalEnvStore,
	options: Omit<TerminalEnvResolveOptions, "global" | "workspace"> = {},
): Promise<ResolvedTerminalEnv> {
	return resolveTerminalEnv({
		...options,
		global: store.getGlobalStateKey("terminalEnvironment"),
		workspace: store.getWorkspaceStateKey("terminalEnvironment"),
	})
}
