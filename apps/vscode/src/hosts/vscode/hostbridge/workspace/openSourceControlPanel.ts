import * as vscode from "vscode"
import { OpenSourceControlPanelRequest, OpenSourceControlPanelResponse } from "@/shared/proto/index.host"

export async function openSourceControlPanel(_: OpenSourceControlPanelRequest): Promise<OpenSourceControlPanelResponse> {
	await vscode.commands.executeCommand("workbench.view.scm")
	return {}
}
