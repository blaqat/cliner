import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ openFile: vi.fn(async () => ({})), showMessage: vi.fn(async () => ({})) }))
vi.mock("./openFile", () => ({ openFile: mocks.openFile }))
vi.mock("@/hosts/host-provider", () => ({ HostProvider: { window: { showMessage: mocks.showMessage } } }))

import { ScriptsHost } from "@/sdk/scripts/script-host"
import { createScriptFile } from "./createScriptFile"
import { refreshScripts } from "./refreshScripts"
import { setScriptApproval } from "./setScriptApproval"
import { toggleScript } from "./toggleScript"

describe("script RPC handlers", () => {
	let root: string
	let workspace: string
	let globalDir: string
	let globalToggles: Record<string, boolean>
	let workspaceToggles: Record<string, boolean>
	let controller: never
	const previousClineDir = process.env.CLINE_DIR

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-script-rpc-"))
		workspace = path.join(root, "repo")
		globalDir = path.join(root, "cline", "scripts")
		process.env.CLINE_DIR = path.join(root, "cline")
		await fs.mkdir(workspace, { recursive: true })
		globalToggles = {}
		workspaceToggles = {}
		mocks.openFile.mockClear()
		const scripts = new ScriptsHost({
			getToggles: () => ({ global: globalToggles, workspace: workspaceToggles }),
			getWorkspaceRoot: () => workspace,
			getLogDir: () => path.join(root, "logs"),
			resolveEnv: async () => ({}),
		})
		controller = {
			scripts,
			getWorkspaceRoot: async () => workspace,
			stateManager: {
				getGlobalSettingsKey: () => globalToggles,
				getWorkspaceStateKey: () => workspaceToggles,
				setGlobalState: (_key: string, value: Record<string, boolean>) => {
					globalToggles = value
				},
				setWorkspaceState: (_key: string, value: Record<string, boolean>) => {
					workspaceToggles = value
				},
			},
		} as never
	})
	afterEach(async () => {
		if (previousClineDir === undefined) delete process.env.CLINE_DIR
		else process.env.CLINE_DIR = previousClineDir
		await fs.rm(root, { recursive: true, force: true })
	})

	it("creates a template in ~/.cline/scripts or .clinerules/scripts, opens it, and lists it", async () => {
		const created = await createScriptFile(controller, { scriptName: "My Script!", isGlobal: true } as never)
		const globalFile = path.join(globalDir, "my-script.md")
		expect(created.globalScripts.map((script) => [script.name, script.path, script.enabled])).toEqual([
			["my-script", globalFile, true],
		])
		expect(mocks.openFile).toHaveBeenCalledWith(controller, { value: globalFile })
		expect(created.globalScripts[0].trusted).toBe(true)

		const local = await createScriptFile(controller, { scriptName: "local", isGlobal: false } as never)
		expect(local.workspaceScripts[0].path).toBe(path.join(workspace, ".clinerules", "scripts", "local.md"))
		expect(local.workspaceScripts[0].options.map((option) => option.name)).toEqual(["who", "shout"])
	})

	it("does not overwrite an existing script", async () => {
		await createScriptFile(controller, { scriptName: "dup", isGlobal: true } as never)
		const file = path.join(globalDir, "dup.md")
		await fs.writeFile(file, "mine")
		await createScriptFile(controller, { scriptName: "dup", isGlobal: true } as never)
		expect(await fs.readFile(file, "utf8")).toBe("mine")
		expect(mocks.showMessage).toHaveBeenCalled()
	})

	it("rejects names that cannot be typed as /name", async () => {
		await expect(createScriptFile(controller, { scriptName: "!!!", isGlobal: true } as never)).rejects.toThrow()
	})

	it("toggles by path in the right scope and reflects it in the list", async () => {
		await createScriptFile(controller, { scriptName: "t", isGlobal: true } as never)
		const file = path.join(globalDir, "t.md")
		const off = await toggleScript(controller, { scriptPath: file, isGlobal: true, enabled: false } as never)
		expect(off.globalScripts[0].enabled).toBe(false)
		expect(globalToggles).toEqual({ [file]: false })
		expect(workspaceToggles).toEqual({})
		const on = await toggleScript(controller, { scriptPath: file, isGlobal: true, enabled: true } as never)
		expect(on.globalScripts[0].enabled).toBe(true)
	})

	it("changes the approval in the file and only for listed scripts", async () => {
		await createScriptFile(controller, { scriptName: "a", isGlobal: true } as never)
		const file = path.join(globalDir, "a.md")
		const changed = await setScriptApproval(controller, { scriptPath: file, approval: "always_allow" } as never)
		expect(changed.globalScripts[0].approval).toBe("always_allow")
		expect(changed.globalScripts[0].trusted).toBe(true)
		expect(await fs.readFile(file, "utf8")).toContain("approval: always_allow")
		await expect(setScriptApproval(controller, { scriptPath: file, approval: "sometimes" } as never)).rejects.toThrow()
		const outside = path.join(root, "other.md")
		await fs.writeFile(outside, "---\ndescription: d\ncommand: x\n---\n")
		await expect(setScriptApproval(controller, { scriptPath: outside, approval: "always_ask" } as never)).rejects.toThrow(
			"Unknown script",
		)
	})

	it("reports invalid scripts with their errors", async () => {
		await fs.mkdir(globalDir, { recursive: true })
		await fs.writeFile(path.join(globalDir, "broken.md"), "---\ndescription: d\n---\n")
		const listed = await refreshScripts(controller, {} as never)
		expect(listed.globalScripts[0]).toMatchObject({ name: "broken", approval: "" })
		expect(listed.globalScripts[0].errors.join()).toContain("command is required")
	})
	it("refuses stale trust actions and trusts resolved mmrc choices", async () => {
		await fs.mkdir(globalDir, { recursive: true })
		await fs.writeFile(path.join(workspace, ".mmrc"), '{"modules":["api"]}')
		const file = path.join(globalDir, "module.md")
		await fs.writeFile(
			file,
			"---\ndescription: d\ncommand: echo {{module}}\noptions: [{name: module, kind: choice, choicesFrom: mmrc}]\n---\n",
		)
		const listed = await refreshScripts(controller, {} as never)
		expect(listed.globalScripts[0].trusted).toBe(false)
		const fingerprint = listed.globalScripts[0].fingerprint
		const trusted = await setScriptApproval(controller, { scriptPath: file, trustOnly: true, fingerprint } as never)
		expect(trusted.globalScripts[0].trusted).toBe(true)
		await fs.writeFile(file, (await fs.readFile(file, "utf8")).replace("echo", "printf"))
		await expect(setScriptApproval(controller, { scriptPath: file, trustOnly: true, fingerprint } as never)).rejects.toThrow(
			"changed",
		)
	})
})
