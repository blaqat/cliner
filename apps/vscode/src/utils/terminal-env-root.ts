import { HostProvider } from "@/hosts/host-provider"

/**
 * The stable base for relative workspace-scope .env paths: the first open
 * workspace folder, independent of the directory a given command runs in or
 * the (possibly worktree) cwd of a thread. The settings preview and command
 * execution both use this, so a path means the same thing in both. Falls back
 * to `fallback` when no host/workspace is available.
 */
export async function getTerminalEnvWorkspaceRoot(fallback: string): Promise<string> {
	try {
		if (HostProvider.isInitialized()) {
			const { paths } = await HostProvider.workspace.getWorkspacePaths({})
			const root = paths?.find((workspacePath) => workspacePath.trim().length > 0)
			if (root) return root
		}
	} catch {
		// Fall through to the caller's fallback.
	}
	return fallback
}
