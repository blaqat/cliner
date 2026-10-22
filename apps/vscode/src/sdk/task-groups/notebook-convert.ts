import { createHash } from "node:crypto"
import { promises as fs } from "node:fs"
import path from "node:path"
import * as yaml from "js-yaml"
import { validateTaskGroupIdentifier } from "./task-group-store"

export type NotebookConversionKind = "rule" | "skill" | "workflow"

/** Directories are resolved by the host's existing rule/workflow/skill helpers. */
export function notebookConversion(
	directory: string,
	kind: NotebookConversionKind,
	slug: string,
	content: string,
	description: string,
) {
	validateTaskGroupIdentifier(slug, "slug")
	if (!["rule", "skill", "workflow"].includes(kind)) throw new Error("Choose Rule, Skill or Workflow")
	if (kind === "skill" && !description.trim()) throw new Error("A skill description is required")
	const file = {
		path: kind === "skill" ? path.join(directory, slug, "SKILL.md") : path.join(directory, `${slug}.md`),
		content:
			kind === "skill"
				? `---\n${yaml.dump({ name: slug, description: description.trim() }).trimEnd()}\n---\n\n${content}`
				: content,
	}
	return { ...file, revision: createHash("sha256").update(JSON.stringify(file)).digest("hex") }
}

export async function createNotebookConversion(file: { path: string; content: string }): Promise<void> {
	await fs.mkdir(path.dirname(file.path), { recursive: true })
	// Never overwrite a rule, workflow or skill the user already has.
	await fs.writeFile(file.path, file.content, { flag: "wx" })
}
