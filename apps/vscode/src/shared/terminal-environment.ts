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

/** Both storage scopes the terminal environment UI edits. */
export interface TerminalEnvironmentState {
	global: TerminalEnvironmentSettings
	workspace: TerminalEnvironmentSettings
}

/** Where a resolved variable's winning value came from. */
export type TerminalEnvironmentSource = "process" | "env_file" | "global" | "workspace"
