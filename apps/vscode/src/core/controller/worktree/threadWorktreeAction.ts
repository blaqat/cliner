import { ThreadWorktreeActionRequest, ThreadWorktreeActionResponse } from "@shared/proto/cline/worktree"
import { HostProvider } from "@/hosts/host-provider"
import { Controller } from ".."

export async function threadWorktreeAction(
	controller: Controller,
	request: ThreadWorktreeActionRequest,
): Promise<ThreadWorktreeActionResponse> {
	// The workspace menu's fix link when uncommitted workspace changes block switching branches.
	if (request.action === "sourceControl") {
		await HostProvider.workspace.openSourceControlPanel({})
		return ThreadWorktreeActionResponse.create({ json: "{}" })
	}
	return ThreadWorktreeActionResponse.create({ json: JSON.stringify(await controller.threadWorktreeAction(request)) })
}
