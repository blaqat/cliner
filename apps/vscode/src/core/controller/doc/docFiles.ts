import { createHash } from "node:crypto"
import { promises as fs } from "node:fs"
import path from "node:path"
import { createCoreSettingsService } from "@cline/core"
import { parseYamlFrontmatter } from "@core/context/instructions/user-instructions/frontmatter"
import * as yaml from "js-yaml"
import { HostProvider } from "@/hosts/host-provider"
import type { Controller } from ".."

export type DocKind = "rule" | "workflow" | "skill"

export interface DocFile {
	path: string
	body: string
	fields: Record<string, unknown>
	revision: string
	readOnlyReason?: string
}

export function parseDocKind(kind: string): DocKind {
	if (kind === "rule" || kind === "workflow" || kind === "skill") return kind
	throw new Error("Choose a rule, workflow or skill")
}

/**
 * The files the Rules panel lists for a kind. The editor only reads and writes
 * these, so a request can never reach an arbitrary path.
 */
async function listedPaths(controller: Controller, kind: DocKind): Promise<string[]> {
	const state = controller.stateManager
	const keys = (toggles: Record<string, boolean> | undefined) => Object.keys(toggles ?? {})
	if (kind === "rule") {
		return [
			...keys(state.getGlobalSettingsKey("globalClineRulesToggles")),
			...keys(state.getWorkspaceStateKey("localClineRulesToggles")),
			...keys(state.getWorkspaceStateKey("localCursorRulesToggles")),
			...keys(state.getWorkspaceStateKey("localWindsurfRulesToggles")),
			...keys(state.getWorkspaceStateKey("localAgentsRulesToggles")),
		]
	}
	if (kind === "workflow") {
		return [
			...keys(state.getGlobalSettingsKey("globalWorkflowToggles")),
			...keys(state.getWorkspaceStateKey("workflowToggles")),
		]
	}
	const workspaceRoot = (await HostProvider.workspace.getWorkspacePaths({})).paths[0]
	const snapshot = await createCoreSettingsService().list({ workspaceRoot })
	return snapshot.skills.map((skill) => skill.path).filter((skillPath): skillPath is string => !!skillPath)
}

export async function resolveDocPath(controller: Controller, kind: DocKind, requested: string): Promise<string> {
	if (!requested || requested.startsWith("remote:")) throw new Error("This one is managed remotely and can't be edited here")
	const resolved = path.resolve(requested)
	const listed = (await listedPaths(controller, kind)).map((entry) => path.resolve(entry))
	if (!listed.includes(resolved)) throw new Error(`That ${kind} isn't in the Rules panel any more. Refresh the list.`)
	const stat = await fs.stat(resolved)
	if (stat.isDirectory()) {
		if (kind !== "skill") throw new Error("This rule is a folder of files. Open it as files to edit it")
		return path.join(resolved, "SKILL.md")
	}
	return resolved
}

function revisionOf(raw: string): string {
	return createHash("sha256").update(raw).digest("hex")
}

export function parseDoc(filePath: string, raw: string): DocFile {
	const parsed = parseYamlFrontmatter(raw)
	return {
		path: filePath,
		body: parsed.hadFrontmatter && !parsed.parseError ? parsed.body.replace(/^\r?\n/, "") : raw,
		fields: parsed.parseError ? {} : parsed.data,
		revision: revisionOf(raw),
		...(parsed.parseError
			? {
					readOnlyReason: `The front matter can't be read (${parsed.parseError.split("\n")[0]}). Open it as a file to fix it.`,
				}
			: {}),
	}
}

/** Front matter from the editor's fields: empty values drop out, so an untouched file keeps its shape. */
export function serializeDoc(fields: Record<string, unknown>, body: string): string {
	const kept = Object.fromEntries(
		Object.entries(fields).filter(
			([, value]) =>
				value !== undefined &&
				value !== null &&
				value !== "" &&
				!(Array.isArray(value) && value.filter((entry) => String(entry).trim()).length === 0),
		),
	)
	if (!Object.keys(kept).length) return body
	return `---\n${yaml.dump(kept, { lineWidth: -1 }).trimEnd()}\n---\n\n${body.replace(/^\n+/, "")}`
}

export async function readDocFile(filePath: string): Promise<DocFile> {
	return parseDoc(filePath, await fs.readFile(filePath, "utf8"))
}

export async function saveDocFile(
	filePath: string,
	input: { body: string; fields: Record<string, unknown>; baseRevision: string },
): Promise<DocFile> {
	const current = await fs.readFile(filePath, "utf8")
	if (input.baseRevision && revisionOf(current) !== input.baseRevision) {
		throw new Error("This file changed after you opened it. Copy your text, then reopen it to see the newer version")
	}
	if (parseDoc(filePath, current).readOnlyReason) throw new Error("Fix the front matter in the file first")
	const next = serializeDoc(input.fields, input.body)
	const tmp = `${filePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`
	await fs.writeFile(tmp, next, "utf8")
	await fs.rename(tmp, filePath)
	return parseDoc(filePath, next)
}
