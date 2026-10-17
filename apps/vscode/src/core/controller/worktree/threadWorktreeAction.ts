import { ThreadWorktreeActionRequest, ThreadWorktreeActionResponse } from "@shared/proto/cline/worktree"
import { Controller } from ".."

export async function threadWorktreeAction(
	controller: Controller,
	request: ThreadWorktreeActionRequest,
): Promise<ThreadWorktreeActionResponse> {
	return ThreadWorktreeActionResponse.create({ json: JSON.stringify(await controller.threadWorktreeAction(request)) })
}
