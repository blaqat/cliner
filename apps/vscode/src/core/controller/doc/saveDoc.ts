import { refreshClineRulesToggles } from "@core/context/instructions/user-instructions/cline-rules"
import { refreshWorkflowToggles } from "@core/context/instructions/user-instructions/workflows"
import { DocContent, SaveDocRequest } from "@shared/proto/cline/doc"
import { getCwd, getDesktopDir } from "@/utils/path"
import { Controller } from ".."
import { parseDocKind, resolveDocPath, saveDocFile } from "./docFiles"
import { docContent } from "./readDoc"

/**
 * Saves a rule, workflow or skill from the doc editor: fields become front
 * matter, the body follows. Refuses when the file changed since it was read.
 * @param controller The controller instance
 * @param request The path, kind, fields (JSON), body and the revision it was read at
 * @returns The saved doc
 */
export async function saveDoc(controller: Controller, request: SaveDocRequest): Promise<DocContent> {
	const kind = parseDocKind(request.kind)
	const filePath = await resolveDocPath(controller, kind, request.path)
	const fields = JSON.parse(request.fieldsJson || "{}")
	if (!fields || typeof fields !== "object" || Array.isArray(fields)) throw new Error("Fields must be an object")
	const saved = await saveDocFile(filePath, { body: request.body, fields, baseRevision: request.baseRevision })
	// A rule's paths or a workflow's name can change what the panel and the agent see.
	const cwd = await getCwd(getDesktopDir())
	if (kind === "rule") await refreshClineRulesToggles(controller, cwd)
	if (kind === "workflow") await refreshWorkflowToggles(controller, cwd)
	await controller.postStateToWebview()
	return docContent(saved)
}
