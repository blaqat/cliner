import type { StateManager } from "@core/storage/StateManager"
import type { SkillItemKind } from "@shared/skillsets"
import { setSkillDisabledInFrontmatter } from "./skills"

function updatedToggles(current: Record<string, boolean> | undefined, file: string, enabled: boolean | undefined) {
	const toggles = { ...current }
	if (enabled === undefined) delete toggles[file]
	else toggles[file] = enabled
	return toggles
}

/** Update one local file's toggle. Without an enabled value, forget a removed file. */
export async function setInstructionFileToggle(
	state: StateManager,
	kind: SkillItemKind,
	file: string,
	isGlobal: boolean,
	enabled?: boolean,
): Promise<Record<string, boolean>> {
	// The SDK reads the enabled state of a skill from its frontmatter.
	if (kind === "skill" && enabled !== undefined) await setSkillDisabledInFrontmatter(file, enabled)

	let toggles: Record<string, boolean>
	if (isGlobal) {
		const key = kind === "skill" ? "globalSkillsToggles" : "globalWorkflowToggles"
		toggles = updatedToggles(state.getGlobalSettingsKey(key), file, enabled)
		state.setGlobalState(key, toggles)
	} else {
		const key = kind === "skill" ? "localSkillsToggles" : "workflowToggles"
		toggles = updatedToggles(state.getWorkspaceStateKey(key), file, enabled)
		state.setWorkspaceState(key, toggles)
	}

	// Acknowledging an explicit toggle must wait for disk, even if the host exits right after.
	if (enabled !== undefined) await state.flushPendingState()
	return toggles
}
