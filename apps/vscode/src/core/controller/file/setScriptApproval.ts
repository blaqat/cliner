import { RefreshedScripts, SetScriptApprovalRequest } from "@shared/proto/cline/file"
import { SCRIPT_APPROVALS, type ScriptApproval } from "@shared/scripts"
import fs from "fs/promises"
import { setScriptApprovalInContent } from "@/sdk/scripts/script-file"
import { Controller } from ".."
import { buildRefreshedScripts } from "./refreshScripts"

/** Writes the approval level into the script's frontmatter (the file stays the source of truth). */
export async function setScriptApproval(controller: Controller, request: SetScriptApprovalRequest): Promise<RefreshedScripts> {
	const approval = request.approval as ScriptApproval
	if (!request.scriptPath || !SCRIPT_APPROVALS.includes(approval)) {
		throw new Error("Missing or invalid parameters for setScriptApproval")
	}
	// Only files the store lists are editable, so the path can't point anywhere else.
	const known = (await controller.scripts.store.list()).find((item) => item.filePath === request.scriptPath)
	if (!known) {
		throw new Error("Unknown script")
	}
	const content = await fs.readFile(request.scriptPath, "utf-8")
	await fs.writeFile(request.scriptPath, setScriptApprovalInContent(content, approval), "utf-8")
	return buildRefreshedScripts(controller)
}
