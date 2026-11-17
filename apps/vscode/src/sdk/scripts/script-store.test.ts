import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { globalScriptsDir, parseMmrcModules, readMmrcModules, ScriptStore, workspaceScriptsDir } from "./script-store"

const script = (name: string, extra = "") =>
	`---\nname: ${name}\ndescription: Does ${name}\ncommand: echo ${name}\n${extra}---\nNotes for ${name}\n`

describe("ScriptStore", () => {
	let root: string
	let globalDir: string
	let workspace: string
	let toggles: { global: Record<string, boolean>; workspace: Record<string, boolean> }
	const makeStore = () =>
		new ScriptStore({ getGlobalDir: () => globalDir, getWorkspaceRoot: () => workspace, getToggles: () => toggles })

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-scripts-"))
		globalDir = path.join(root, "home", ".cline", "scripts")
		workspace = path.join(root, "repo")
		toggles = { global: {}, workspace: {} }
		await fs.mkdir(globalDir, { recursive: true })
		await fs.mkdir(workspaceScriptsDir(workspace), { recursive: true })
	})
	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true })
	})

	it("lists global and workspace scripts, workspace first, ignoring non-markdown files", async () => {
		await fs.writeFile(path.join(globalDir, "g.md"), script("g"))
		await fs.writeFile(path.join(globalDir, "notes.txt"), "ignored")
		await fs.writeFile(path.join(workspaceScriptsDir(workspace), "w.md"), script("w"))
		const all = await makeStore().list()
		expect(all.map((item) => [item.scope, item.name, item.enabled])).toEqual([
			["workspace", "w", true],
			["global", "g", true],
		])
	})

	it("uses .clinerules/scripts for the workspace", () => {
		expect(workspaceScriptsDir("/repo")).toBe(path.join("/repo", ".clinerules", "scripts"))
	})

	it("lists invalid scripts with their errors but never offers them", async () => {
		await fs.writeFile(path.join(globalDir, "bad.md"), "---\ndescription: d\n---\n")
		const store = makeStore()
		const [bad] = await store.list()
		expect(bad).toMatchObject({ name: "bad", enabled: true })
		expect(bad.errors[0]).toContain("command is required")
		expect(await store.listEnabled()).toEqual([])
	})

	it("applies toggles by file path; unknown files are on", async () => {
		const file = path.join(globalDir, "g.md")
		await fs.writeFile(file, script("g"))
		await fs.writeFile(path.join(globalDir, "h.md"), script("h"))
		toggles.global[file] = false
		const store = makeStore()
		expect((await store.listEnabled()).map((entry) => entry.name)).toEqual(["h"])
		expect(await store.find("g")).toBeUndefined()
	})

	it("lets a workspace script shadow a global one with the same name", async () => {
		await fs.writeFile(path.join(globalDir, "t.md"), script("t").replace("echo t", "echo global"))
		await fs.writeFile(path.join(workspaceScriptsDir(workspace), "t.md"), script("t").replace("echo t", "echo workspace"))
		const found = await makeStore().find("t")
		expect(found?.command).toBe("echo workspace")
		expect(found?.scope).toBe("workspace")
	})

	it("falls back to the global script when the workspace one is switched off", async () => {
		await fs.writeFile(path.join(globalDir, "t.md"), script("t"))
		const wsFile = path.join(workspaceScriptsDir(workspace), "t.md")
		await fs.writeFile(wsFile, script("t"))
		toggles.workspace[wsFile] = false
		expect((await makeStore().find("t"))?.scope).toBe("global")
	})

	it("fills choicesFrom: mmrc with the modules of the nearest .mmrc", async () => {
		await fs.writeFile(
			path.join(workspace, ".mmrc"),
			JSON.stringify({ modules: ["packages/api", { path: "apps/web", name: "site" }] }),
		)
		await fs.writeFile(
			path.join(globalDir, "m.md"),
			script("m", "options:\n  - name: mod\n    kind: choice\n    choicesFrom: mmrc\n"),
		)
		const store = makeStore()
		const found = await store.find("m")
		expect(found?.options[0].choices).toEqual(["api", "site"])
	})

	it("peekEnabled serves the last load for synchronous prompt text", async () => {
		await fs.writeFile(path.join(globalDir, "g.md"), script("g"))
		const store = makeStore()
		expect(store.peekEnabled()).toEqual([])
		await store.list()
		expect(store.peekEnabled().map((entry) => entry.name)).toEqual(["g"])
	})
})

describe("mmrc", () => {
	it("parses JSON object, JSON array and one-path-per-line formats", () => {
		expect(parseMmrcModules('{"modules": ["a/api", {"path": "b/web", "name": "site"}]}')).toEqual(["api", "site"])
		expect(parseMmrcModules('["x", "y/"]')).toEqual(["x", "y"])
		expect(parseMmrcModules("# comment\napi\n\nweb\napi\n")).toEqual(["api", "web"])
		expect(parseMmrcModules("{ not json")).toEqual([])
	})

	it("searches upward from the start directory", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-mmrc-"))
		try {
			await fs.mkdir(path.join(root, "a", "b"), { recursive: true })
			await fs.writeFile(path.join(root, ".mmrc"), "one\ntwo\n")
			expect(await readMmrcModules(path.join(root, "a", "b"))).toEqual(["one", "two"])
		} finally {
			await fs.rm(root, { recursive: true, force: true })
		}
	})
})

describe("globalScriptsDir", () => {
	const original = process.env.CLINE_DIR
	afterEach(() => {
		if (original === undefined) delete process.env.CLINE_DIR
		else process.env.CLINE_DIR = original
	})

	it("follows the shared ~/.cline resolver, so tests can redirect it", () => {
		process.env.CLINE_DIR = path.join(os.tmpdir(), "redirected-cline")
		expect(globalScriptsDir()).toBe(path.join(os.tmpdir(), "redirected-cline", "scripts"))
	})
})
