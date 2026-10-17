/**
 * Terminal environment settings, per scope. Stored once in global state
 * (applies everywhere) and once in per-workspace state (overrides, never
 * written to the repo). Values merge into every command Cline runs.
 */
export interface TerminalEnvironmentSettings {
	/** Plain env vars set on top of process.env; workspace wins over global. */
	variables?: Record<string, string>
	/** Optional dotenv-style file read when a command runs; only the path is stored. */
	envFilePath?: string
	/** Extra directories prepended to PATH, workspace entries before global ones. */
	pathEntries?: string[]
}

/** Where a resolved variable's winning value came from. */
export type TerminalEnvironmentSource = "process" | "env_file" | "global" | "workspace"

/**
 * Stand-in for a stored variable value in ordinary webview state. Real values
 * only travel through the explicit reveal RPC; sending this back in an update
 * means "leave the stored value alone", so a masked placeholder can never
 * overwrite a secret.
 */
export const TERMINAL_ENV_UNCHANGED = "__cline_terminal_env_unchanged__"

/** One scope as the webview sees it: variable names (masked) but never values. */
export interface TerminalEnvironmentWebviewScope {
	/** Every value is {@link TERMINAL_ENV_UNCHANGED}. */
	variables: Record<string, string>
	envFilePath?: string
	pathEntries?: string[]
}

/** Both scopes of the terminal environment as sent in webview state. */
export interface TerminalEnvironmentWebviewState {
	global: TerminalEnvironmentWebviewScope
	workspace: TerminalEnvironmentWebviewScope
}

/** Replace every variable value of a scope with the masked placeholder. */
export function maskTerminalEnvironmentScope(scope: TerminalEnvironmentSettings | undefined): TerminalEnvironmentWebviewScope {
	return {
		variables: Object.fromEntries(Object.keys(scope?.variables ?? {}).map((name) => [name, TERMINAL_ENV_UNCHANGED])),
		envFilePath: scope?.envFilePath,
		pathEntries: scope?.pathEntries,
	}
}

/**
 * Global-scope .env paths have no workspace to be relative to, so they must be
 * absolute or `~`-relative. Returns an inline explanation when the path is
 * neither, otherwise undefined. (Workspace paths may be relative: they resolve
 * against the workspace root.)
 */
export function globalEnvFilePathProblem(filePath: string | undefined): string | undefined {
	const value = filePath?.trim()
	if (!value) return undefined
	if (/^(~([\\/]|$)|[\\/]|[A-Za-z]:[\\/])/.test(value)) return undefined
	return "Global .env paths must be absolute or start with ~ (for example ~/secrets/dev.env). Relative paths only work in the Workspace scope, where they resolve against the workspace root."
}

/** A granular edit to one scope; omitted fields are left exactly as stored. */
export interface TerminalEnvironmentPatch {
	setVariables?: Record<string, string>
	removeVariables?: string[]
	/** Present (even empty) replaces the .env path; absent keeps it. */
	envFilePath?: string
	addPathEntries?: string[]
	removePathEntries?: string[]
}

/**
 * Apply a patch to a stored scope. Applied against the freshest stored value,
 * so consecutive edits compose in arrival order instead of overwriting each
 * other with stale whole-scope snapshots. Sentinel values are skipped so a
 * masked placeholder never replaces a real secret.
 */
export function applyTerminalEnvironmentPatch(
	current: TerminalEnvironmentSettings | undefined,
	patch: TerminalEnvironmentPatch,
): TerminalEnvironmentSettings {
	const variables = { ...(current?.variables ?? {}) }
	for (const name of patch.removeVariables ?? []) delete variables[name]
	for (const [name, value] of Object.entries(patch.setVariables ?? {})) {
		const trimmed = name.trim()
		if (!trimmed || value === TERMINAL_ENV_UNCHANGED) continue
		variables[trimmed] = value
	}
	let pathEntries = [...(current?.pathEntries ?? [])]
	for (const entry of patch.removePathEntries ?? []) {
		const index = pathEntries.indexOf(entry)
		if (index >= 0) pathEntries.splice(index, 1)
	}
	for (const entry of patch.addPathEntries ?? []) {
		const trimmed = entry.trim()
		if (trimmed && !pathEntries.includes(trimmed)) pathEntries.push(trimmed)
	}
	pathEntries = pathEntries.filter((entry) => entry.length > 0)
	const envFilePath = patch.envFilePath !== undefined ? patch.envFilePath.trim() || undefined : current?.envFilePath
	return { variables, envFilePath, pathEntries }
}
