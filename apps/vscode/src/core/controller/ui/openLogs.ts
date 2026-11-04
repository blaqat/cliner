import { Empty, type EmptyRequest } from "@shared/proto/cline/common"
import { showClineOutputChannel } from "@/hosts/vscode/hostbridge/env/debugLog"
import type { Controller } from ".."
export async function openLogs(_controller: Controller, _request: EmptyRequest): Promise<Empty> {
	showClineOutputChannel()
	return Empty.create({})
}
