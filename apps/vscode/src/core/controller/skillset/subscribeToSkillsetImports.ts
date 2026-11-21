import type { EmptyRequest } from "@shared/proto/cline/common"
import { SkillsetJson } from "@shared/proto/cline/skillset"
import { addSkillsetImportListener } from "@/sdk/skills/skillset-handlers"
import type { Controller } from ".."
import { getRequestRegistry, type StreamingResponseHandler } from "../grpc-handler"

/** Imports started outside the webview (the Cline: Add skillset command) reach the panel here. */
export async function subscribeToSkillsetImports(
	_controller: Controller,
	_request: EmptyRequest,
	responseStream: StreamingResponseHandler<SkillsetJson>,
	requestId?: string,
): Promise<void> {
	const remove = addSkillsetImportListener((result) =>
		responseStream(SkillsetJson.create({ json: JSON.stringify(result) }), false),
	)
	if (requestId)
		getRequestRegistry().registerRequest(requestId, remove, { type: "skillset_imports_subscription" }, responseStream)
}
