import * as proto from "@/shared/proto"
import { Controller } from "../index"

/**
 * Returns the real variable values of ONE scope (request.value: true for
 * workspace). Only the settings editor's eye toggle calls this; ordinary
 * webview state carries names with masked placeholders. Values are never
 * logged.
 */
export async function revealTerminalEnvironment(
	controller: Controller,
	request: proto.cline.BooleanRequest,
): Promise<proto.cline.TerminalEnvironmentValues> {
	const scope = request.value
		? controller.stateManager.getWorkspaceStateKey("terminalEnvironment")
		: controller.stateManager.getGlobalStateKey("terminalEnvironment")
	return proto.cline.TerminalEnvironmentValues.create({ variables: { ...(scope?.variables ?? {}) } })
}
