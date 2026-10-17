import { EmptyRequest } from "@shared/proto/cline/common"
import { RefreshedScripts, ScriptInfo, ScriptOptionInfo } from "@shared/proto/cline/file"
import type { LoadedScript } from "@/sdk/scripts/script-store"
import { Controller } from ".."

function toScriptInfo(item: LoadedScript): ScriptInfo {
	return ScriptInfo.create({
		name: item.name,
		description: item.description,
		path: item.filePath,
		enabled: item.enabled,
		approval: item.script?.approval ?? "",
		errors: item.errors,
		options: (item.script?.options ?? []).map((option) =>
			ScriptOptionInfo.create({
				name: option.name,
				kind: option.kind,
				required: option.required,
				description: option.description,
				choices: option.choices ?? [],
				hasDefault: option.default !== undefined,
				defaultValue: option.default === undefined ? "" : String(option.default),
				choicesFrom: option.choicesFrom ?? "",
			}),
		),
	})
}

/** Every script file, split by scope, with toggles applied. */
export async function buildRefreshedScripts(controller: Controller): Promise<RefreshedScripts> {
	await controller.getWorkspaceRoot()
	const all = await controller.scripts.store.list()
	return RefreshedScripts.create({
		globalScripts: all.filter((item) => item.scope === "global").map(toScriptInfo),
		workspaceScripts: all.filter((item) => item.scope === "workspace").map(toScriptInfo),
	})
}

/**
 * Lists saved scripts: `~/.cline/scripts/*.md` and `<workspace>/.clinerules/scripts/*.md`.
 * Always reads from disk, so edits made in the editor show up on the next poll.
 */
export async function refreshScripts(controller: Controller, _request: EmptyRequest): Promise<RefreshedScripts> {
	return buildRefreshedScripts(controller)
}
