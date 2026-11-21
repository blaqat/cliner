import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { toggleSkill } from "@core/controller/file/toggleSkill"
import { toggleWorkflow } from "@core/controller/file/toggleWorkflow"
import { StateManager } from "@core/storage/StateManager"
import { RuleScope, ToggleSkillRequest, ToggleWorkflowRequest } from "@shared/proto/cline/file"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Controller } from "@/core/controller"
import { HostProvider } from "@/hosts/host-provider"
import { createStorageContext, type StorageContext } from "@/shared/storage/storage-context"
import { applySkillDraft } from "./skill-drafts"
import { parseSkillMarkdown } from "./skill-files"
import { importSkillset, updateSkillsetItems } from "./skillset-service"
import { vscodeSkillDraftPlaces, vscodeSkillsetEnvironment } from "./vscode-skillset-env"
import { writeZip } from "./zip"

vi.mock("@core/storage/documents-path", () => ({
	getDocumentsPath: async () => path.join(os.homedir(), "Documents"),
}))

describe("VS Code skill and workflow toggle persistence", () => {
	let root: string
	let workspace: string
	let controller: Controller
	const managers: StateManager[] = []

	const open = async () => {
		const storage = createStorageContext({ clineDir: root, workspacePath: workspace })
		const manager = new (StateManager as unknown as new (storage: StorageContext) => StateManager)(storage)
		managers.push(manager)
		// An immediate restart cannot rely on a background timer or a shutdown flush.
		vi.spyOn(
			manager as unknown as { scheduleDebouncedPersistence(): void },
			"scheduleDebouncedPersistence",
		).mockImplementation(() => {})
		await manager.loadFromStorage()
		return { stateManager: manager, postStateToWebview: vi.fn() } as unknown as Controller
	}

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-toggle-persistence-"))
		workspace = path.join(root, "workspace")
		await fs.mkdir(workspace)
		vi.spyOn(os, "homedir").mockReturnValue(root)
		vi.stubEnv("CLINE_DATA_DIR", path.join(root, "data"))
		vi.spyOn(HostProvider, "workspace", "get").mockReturnValue({
			getWorkspacePaths: vi.fn(async () => ({ paths: [workspace] })),
		} as unknown as typeof HostProvider.workspace)
		controller = await open()
	})

	afterEach(async () => {
		for (const manager of managers.splice(0)) (manager as unknown as { dispose(): void }).dispose()
		vi.restoreAllMocks()
		vi.unstubAllEnvs()
		await fs.rm(root, { recursive: true, force: true })
	})

	it.each(["Turn all on", "Turn on"])("%s persists an imported workflow before a restart", async (action) => {
		const env = await vscodeSkillsetEnvironment(controller)
		const zip = writeZip([
			{ path: "skills/deploy/SKILL.md", data: Buffer.from("---\nname: deploy\ndescription: Deploy\n---\nSteps\n") },
			{ path: "workflows/deploy.md", data: Buffer.from("# Deploy") },
		])
		const result = await importSkillset(env, zip, "deploy.skillset.zip")
		expect(result.error).toBeUndefined()
		const set = result.set!
		const workflow = set.items.find((item) => item.kind === "workflow")!
		const skill = set.items.find((item) => item.kind === "skill")!
		// Start from the imported OFF state already on disk, as it would be after the debounce.
		await controller.stateManager.flushPendingState()
		await updateSkillsetItems(env, {
			setId: set.id,
			action: "turn_on",
			paths: action === "Turn on" ? [workflow.path] : [],
		})

		const reopened = await open()
		const afterRestart = await vscodeSkillsetEnvironment(reopened)
		expect(await afterRestart.listWorkflows()).toContainEqual({ path: workflow.path, isGlobal: true, enabled: true })
		const skillEnabled = action === "Turn all on"
		expect(reopened.stateManager.getGlobalSettingsKey("globalSkillsToggles")[skill.path]).toBe(skillEnabled)
		expect(parseSkillMarkdown(await fs.readFile(skill.path, "utf8")).extra.disabled === true).toBe(!skillEnabled)
	})

	it.each([true, false])("persists Skills and Workflows tab toggles immediately (global=%s)", async (isGlobal) => {
		const places = vscodeSkillDraftPlaces(workspace)
		const scope = isGlobal ? "global" : "workspace"
		const skillDir = path.join(await places.skillsDir(scope), "deploy")
		const workflow = path.join(await places.workflowsDir(scope), "deploy.md")
		const skill = path.join(skillDir, "SKILL.md")
		await fs.mkdir(skillDir, { recursive: true })
		await fs.mkdir(path.dirname(workflow), { recursive: true })
		await fs.writeFile(skill, "---\nname: deploy\ndescription: Deploy\n---\nSteps\n")
		await fs.writeFile(workflow, "# Deploy")

		await toggleSkill(controller, ToggleSkillRequest.create({ skillPath: skill, isGlobal, enabled: false }))
		await toggleWorkflow(
			controller,
			ToggleWorkflowRequest.create({
				workflowPath: workflow,
				scope: isGlobal ? RuleScope.GLOBAL : RuleScope.LOCAL,
				enabled: false,
			}),
		)

		const reopened = await open()
		const afterRestart = await vscodeSkillsetEnvironment(reopened)
		expect(await afterRestart.listWorkflows()).toContainEqual({ path: workflow, isGlobal, enabled: false })
		const skillToggles = isGlobal
			? reopened.stateManager.getGlobalSettingsKey("globalSkillsToggles")
			: reopened.stateManager.getWorkspaceStateKey("localSkillsToggles")
		expect(skillToggles[skill]).toBe(false)
		expect(parseSkillMarkdown(await fs.readFile(skill, "utf8")).extra.disabled).toBe(true)
	})

	it("persists a workflow switched on by Keep before a restart", async () => {
		const places = vscodeSkillDraftPlaces(workspace)
		const env = await vscodeSkillsetEnvironment(controller)
		const workflow = path.join(await places.workflowsDir("workspace"), "ship.md")
		await toggleWorkflow(
			controller,
			ToggleWorkflowRequest.create({ workflowPath: workflow, scope: RuleScope.LOCAL, enabled: false }),
		)
		await controller.stateManager.flushPendingState()
		await applySkillDraft(
			{
				op: "create",
				slug: "skill-ship",
				name: "ship",
				description: "Ship",
				content: "Steps",
				skill: { kind: "workflow", scope: "workspace" },
			},
			undefined,
			places,
			(_kind, file, isGlobal) => env.setWorkflowEnabled(file, isGlobal, true),
		)

		const afterRestart = await vscodeSkillsetEnvironment(await open())
		expect(await afterRestart.listWorkflows()).toContainEqual({ path: workflow, isGlobal: false, enabled: true })
	})
})
