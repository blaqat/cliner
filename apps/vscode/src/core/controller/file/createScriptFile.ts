import { CreateScriptRequest, RefreshedScripts } from "@shared/proto/cline/file"
import { SCRIPT_NAME_REGEX } from "@shared/scripts"
import fs from "fs/promises"
import path from "path"
import { HostProvider } from "@/hosts/host-provider"
import { parseScriptFile, scriptTemplate } from "@/sdk/scripts/script-file"
import { globalScriptsDir, workspaceScriptsDir } from "@/sdk/scripts/script-store"
import { ShowMessageType } from "@/shared/proto/host/window"
import { fileExistsAtPath } from "@/utils/fs"
import { Controller } from ".."
import { openFile } from "./openFile"
import { buildRefreshedScripts } from "./refreshScripts"

/** Creates `<name>.md` from the template in the global or workspace scripts folder and opens it. */
export async function createScriptFile(controller: Controller, request: CreateScriptRequest): Promise<RefreshedScripts> {
	const name = (request.scriptName || "")
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "")
	if (!SCRIPT_NAME_REGEX.test(name)) {
		throw new Error("Script names use lowercase letters, digits, - and _")
	}
	const dir = request.isGlobal ? globalScriptsDir() : workspaceScriptsDir(await controller.getWorkspaceRoot())
	const filePath = path.join(dir, `${name}.md`)
	if (await fileExistsAtPath(filePath)) {
		await HostProvider.window.showMessage({
			type: ShowMessageType.WARNING,
			message: `Script "${name}" already exists`,
		})
		return buildRefreshedScripts(controller)
	}
	await fs.mkdir(dir, { recursive: true })
	const content = scriptTemplate(name)
	await fs.writeFile(filePath, content, { encoding: "utf-8", flag: "wx" })
	const script = parseScriptFile(content, {
		filePath,
		scope: request.isGlobal ? "global" : "workspace",
		fallbackName: name,
	}).script
	if (script) await controller.scripts.store.trust.trust(script)
	await openFile(controller, { value: filePath })
	return buildRefreshedScripts(controller)
}
