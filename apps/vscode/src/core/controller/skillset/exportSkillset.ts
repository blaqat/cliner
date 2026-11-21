import type { ExportSkillsetRequest } from "@shared/proto/cline/skillset"
import { SkillsetJson } from "@shared/proto/cline/skillset"
import type { SkillItemKind } from "@shared/skillsets"
import { saveSkillset } from "@/sdk/skills/skillset-handlers"
import type { Controller } from ".."

/** Saves picked skills and workflows as a skillset through the save dialog. */
export async function exportSkillset(controller: Controller, request: ExportSkillsetRequest): Promise<SkillsetJson> {
	const raw = JSON.parse(request.itemsJson || "[]") as unknown
	const items = (Array.isArray(raw) ? raw : []).flatMap((item) =>
		item && (item.kind === "skill" || item.kind === "workflow") && typeof item.path === "string"
			? [{ kind: item.kind as SkillItemKind, path: item.path as string }]
			: [],
	)
	const result = await saveSkillset(controller, { name: request.name, description: request.description, items })
	return SkillsetJson.create({ json: JSON.stringify(result) })
}
