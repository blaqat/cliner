import { AutomationInfo, AutomationList } from "@shared/proto/cline/automation"
import { EmptyRequest } from "@shared/proto/cline/common"
import type { LoadedAutomation } from "@/sdk/automations/automation-store"
import { Controller } from ".."

function toInfo(item: LoadedAutomation): AutomationInfo {
	return AutomationInfo.create({
		name: item.name,
		description: item.description,
		path: item.filePath,
		scope: item.scope,
		errors: item.errors,
		trusted: item.trusted,
		fingerprint: item.fingerprint,
		definitionJson: item.definition ? JSON.stringify(item.definition) : "",
		content: item.content,
	})
}

/** Every automation file, workspace first. Always reads from disk, so files edited elsewhere show up. */
export async function buildAutomationList(controller: Controller, savedPath = ""): Promise<AutomationList> {
	await controller.getWorkspaceRoot()
	const { store } = controller.automations
	return AutomationList.create({
		automations: (await store.list()).map(toInfo),
		savedPath,
		globalDir: store.dirFor("global") ?? "",
		workspaceDir: store.dirFor("workspace") ?? "",
	})
}

/** Lists `~/.cline/automations/*.md` and `<workspace>/.clinerules/automations/*.md`. */
export async function listAutomations(controller: Controller, _request: EmptyRequest): Promise<AutomationList> {
	return buildAutomationList(controller)
}
