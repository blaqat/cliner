import { RefreshedScripts, SetScriptApprovalRequest } from "@shared/proto/cline/file"
import { SCRIPT_APPROVALS, type ScriptApproval } from "@shared/scripts"
import fs from "fs/promises"
import { parseScriptFile, setScriptApprovalInContent } from "@/sdk/scripts/script-file"
import { scriptFingerprint } from "@/sdk/scripts/script-trust"
import { Controller } from ".."
import { buildRefreshedScripts } from "./refreshScripts"

/** Writes the approval level into the script's frontmatter and trusts that exact definition. */
export async function setScriptApproval(controller: Controller, request: SetScriptApprovalRequest): Promise<RefreshedScripts> {
	const approval = request.approval as ScriptApproval
	if (!request.scriptPath || (!request.trustOnly && !SCRIPT_APPROVALS.includes(approval))) {
		throw new Error("Missing or invalid parameters for setScriptApproval")
	}
	// Only files the store lists are editable, so the path can't point anywhere else.
	const known = (await controller.scripts.store.list()).find((item) => item.filePath === request.scriptPath)
	if (!known) {
		throw new Error("Unknown script")
	}
	const content = await fs.readFile(request.scriptPath, "utf-8")
	const current = parseScriptFile(content, { filePath: known.filePath, scope: known.scope, fallbackName: known.name }).script
	for (const option of current?.options ?? []) {
		if (option.choicesFrom === "mmrc")
			option.choices = known.script?.options.find((candidate) => candidate.name === option.name)?.choices ?? []
	}
	if (!current || (request.fingerprint && request.fingerprint !== scriptFingerprint(current)))
		throw new Error("Script changed. Review the current version and try again.")
	const nextContent = request.trustOnly ? content : setScriptApprovalInContent(content, approval)
	const next = parseScriptFile(nextContent, { filePath: known.filePath, scope: known.scope, fallbackName: known.name }).script
	if (!next) throw new Error("Invalid script")
	for (const option of next.options) {
		if (option.choicesFrom === "mmrc")
			option.choices = current.options.find((candidate) => candidate.name === option.name)?.choices ?? []
	}
	if (!request.trustOnly) await fs.writeFile(request.scriptPath, nextContent, "utf-8")
	await controller.scripts.store.trust.trust(next)
	return buildRefreshedScripts(controller)
}
