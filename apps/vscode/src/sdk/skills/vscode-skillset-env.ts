import { createCoreSettingsService } from "@cline/core"
import { resolveClineDataDir } from "@cline/shared/storage"
import { setSkillDisabledInFrontmatter } from "@core/context/instructions/user-instructions/skills"
import { refreshWorkflowToggles } from "@core/context/instructions/user-instructions/workflows"
import { ensureAgentSkillsDirectoryExists, ensureWorkflowsDirectoryExists, GlobalFileNames } from "@core/storage/disk"
import { getSkillsDirectoriesForScan } from "@core/storage/skill-directories"
import type { SkillItemKind } from "@shared/skillsets"
import os from "os"
import * as path from "path"
import type { Controller } from "@/core/controller"
import { HostProvider } from "@/hosts/host-provider"
import { ExtensionRegistryInfo } from "@/registry"
import type { SkillDraftPlaces } from "./skill-drafts"
import type { SkillsetEnvironment } from "./skillset-service"

/** The real folders and toggle state behind skillsets, for the open workspace. */
export async function vscodeSkillsetEnvironment(controller: Controller): Promise<SkillsetEnvironment> {
	const workspaceRoot = (await HostProvider.workspace.getWorkspacePaths({})).paths[0]
	const state = controller.stateManager
	const setToggle = (key: "globalSkillsToggles" | "globalWorkflowToggles", itemPath: string, enabled?: boolean) => {
		const toggles = { ...(state.getGlobalSettingsKey(key) || {}) }
		if (enabled === undefined) delete toggles[itemPath]
		else toggles[itemPath] = enabled
		state.setGlobalState(key, toggles)
	}
	const setWorkspaceToggle = (key: "localSkillsToggles" | "workflowToggles", itemPath: string, enabled?: boolean) => {
		const toggles = { ...(state.getWorkspaceStateKey(key) || {}) }
		if (enabled === undefined) delete toggles[itemPath]
		else toggles[itemPath] = enabled
		state.setWorkspaceState(key, toggles)
	}
	return {
		globalSkillsDir: () => ensureAgentSkillsDirectoryExists({ isGlobal: true }),
		globalWorkflowsDir: () => ensureWorkflowsDirectoryExists(),
		skillScanDirs: () =>
			getSkillsDirectoriesForScan(workspaceRoot ?? os.homedir())
				.filter((dir) => workspaceRoot || dir.source === "global")
				.map((dir) => ({ path: dir.path, isGlobal: dir.source === "global" })),
		workspaceWorkflowsDir: () => (workspaceRoot ? path.join(workspaceRoot, GlobalFileNames.workflows) : undefined),
		registryPath: path.join(resolveClineDataDir(), "skillsets.json"),
		listSkills: async () => {
			const snapshot = await createCoreSettingsService().list({ workspaceRoot })
			return snapshot.skills
				.filter((skill) => !!skill.path && !skill.path.startsWith("remote:"))
				.map((skill) => ({
					name: skill.name,
					description: skill.description ?? "",
					path: skill.path as string,
					isGlobal: skill.source === "global" || skill.source === "global-plugin",
					enabled: skill.enabled !== false,
				}))
		},
		listWorkflows: async () => {
			const toggles = await refreshWorkflowToggles(controller, workspaceRoot ?? os.homedir())
			return [
				...Object.entries(toggles.globalWorkflowToggles).map(([file, enabled]) => ({
					path: file,
					isGlobal: true,
					enabled: enabled !== false,
				})),
				...(workspaceRoot
					? Object.entries(toggles.localWorkflowToggles).map(([file, enabled]) => ({
							path: file,
							isGlobal: false,
							enabled: enabled !== false,
						}))
					: []),
			]
		},
		setSkillEnabled: async (skillMdPath, isGlobal, enabled) => {
			if (isGlobal) setToggle("globalSkillsToggles", skillMdPath, enabled)
			else setWorkspaceToggle("localSkillsToggles", skillMdPath, enabled)
			await setSkillDisabledInFrontmatter(skillMdPath, enabled)
		},
		setWorkflowEnabled: async (workflowPath, isGlobal, enabled) => {
			if (isGlobal) setToggle("globalWorkflowToggles", workflowPath, enabled)
			else setWorkspaceToggle("workflowToggles", workflowPath, enabled)
		},
		forgetToggle: async (kind: SkillItemKind, itemPath: string, isGlobal: boolean) => {
			if (kind === "skill") {
				if (isGlobal) setToggle("globalSkillsToggles", itemPath)
				else setWorkspaceToggle("localSkillsToggles", itemPath)
			} else if (isGlobal) setToggle("globalWorkflowToggles", itemPath)
			else setWorkspaceToggle("workflowToggles", itemPath)
		},
		appVersion: ExtensionRegistryInfo.version,
	}
}

/** Where staged skill drafts are looked up and kept, for a session's workspace. */
export function vscodeSkillDraftPlaces(workspaceRoot: string | undefined): SkillDraftPlaces {
	return {
		workspaceRoot,
		skillScanDirs: () =>
			getSkillsDirectoriesForScan(workspaceRoot ?? os.homedir())
				.filter((dir) => workspaceRoot || dir.source === "global")
				.map((dir) => ({ path: dir.path, isGlobal: dir.source === "global" })),
		skillsDir: (scope) => ensureAgentSkillsDirectoryExists({ isGlobal: scope === "global", workspacePath: workspaceRoot }),
		workflowsDir: async (scope) =>
			scope === "global" ? ensureWorkflowsDirectoryExists() : path.join(workspaceRoot ?? "", GlobalFileNames.workflows),
		workflowDirs: async () => [
			{ path: await ensureWorkflowsDirectoryExists(), isGlobal: true },
			...(workspaceRoot ? [{ path: path.join(workspaceRoot, GlobalFileNames.workflows), isGlobal: false }] : []),
		],
	}
}
