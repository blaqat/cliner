import * as proto from "@/shared/proto"
import { resolveConfiguredTerminalEnv } from "@/utils/terminal-env"
import { getTerminalEnvWorkspaceRoot } from "@/utils/terminal-env-root"
import { Controller } from "../index"

/**
 * Resolves the effective terminal environment for the settings preview.
 * Variable *names* and their winning source only — values are never
 * serialized to the webview.
 */
export async function resolveTerminalEnvironment(
	controller: Controller,
	_request: proto.cline.EmptyRequest,
): Promise<proto.cline.TerminalEnvironmentResolution> {
	const cwd = await controller.getWorkspaceRoot()
	// Same base command execution uses, so the preview matches what runs.
	const workspaceRoot = await getTerminalEnvWorkspaceRoot(cwd)
	const resolved = await resolveConfiguredTerminalEnv(controller.stateManager, { cwd, workspaceRoot })
	const variables = Object.entries(resolved.sources)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([name, info]) =>
			proto.cline.TerminalEnvironmentVariable.create({
				name,
				source: info.source,
				overriddenSource: info.overridden,
			}),
		)
	return proto.cline.TerminalEnvironmentResolution.create({ variables })
}
