import { DocContent, DocRequest } from "@shared/proto/cline/doc"
import { Controller } from ".."
import { type DocFile, parseDocKind, readDocFile, resolveDocPath } from "./docFiles"

export function docContent(doc: DocFile): DocContent {
	return DocContent.create({
		path: doc.path,
		body: doc.body,
		fieldsJson: JSON.stringify(doc.fields),
		revision: doc.revision,
		readOnlyReason: doc.readOnlyReason ?? "",
	})
}

/**
 * Reads a rule, workflow or skill the Rules panel lists, as fields and body.
 * @param controller The controller instance
 * @param request The file path and its kind
 * @returns The doc's fields, body and revision
 */
export async function readDoc(controller: Controller, request: DocRequest): Promise<DocContent> {
	const filePath = await resolveDocPath(controller, parseDocKind(request.kind), request.path)
	return docContent(await readDocFile(filePath))
}
