import { execFileSync } from "node:child_process"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import * as repositoryTools from "./repositories"
import { ThreadWorktreeManager } from "./thread-worktree-manager"

const mmPath = "/Users/blaqat/dev/tools/scripts/mm.js"
const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		env: { ...process.env, GIT_ALLOW_PROTOCOL: "file" },
		stdio: ["pipe", "pipe", "pipe"],
	}).trim()
const write = (dir: string, file: string, text: string) => fs.writeFile(path.join(dir, file), text)
const read = (dir: string, file: string) => fs.readFile(path.join(dir, file), "utf8")
let temp: string
function identity(dir: string) {
	git(dir, "config", "user.name", "Submodule test")
	git(dir, "config", "user.email", "test@example.invalid")
}
async function repo(dir: string) {
	await fs.mkdir(dir, { recursive: true })
	git(dir, "init", "-b", "main")
	identity(dir)
	await write(dir, "file.txt", "base\n")
	git(dir, "add", ".")
	git(dir, "commit", "-m", "base")
}
async function fixture(mode: "git" | "mm", configuredSubmodule = false) {
	const leaf = path.join(temp, "leaf")
	const middle = path.join(temp, "middle")
	const source = path.join(temp, "source")
	await repo(leaf)
	await repo(middle)
	git(middle, "submodule", "add", "../leaf", "nested child")
	git(middle, "commit", "-am", "nested")
	await repo(source)
	git(source, "submodule", "add", "../middle", "vendor")
	git(source, "commit", "-am", "vendor")
	const workspace = path.join(temp, "workspace")
	const root = mode === "git" ? workspace : path.join(workspace, "api")
	await fs.mkdir(path.dirname(root), { recursive: true })
	if (configuredSubmodule) {
		await repo(workspace)
		git(workspace, "submodule", "add", "../source", "api")
		git(workspace, "commit", "-am", "configured module")
	} else git(temp, "clone", source, root)
	git(root, "submodule", "update", "--init", "--recursive")
	identity(root)
	if (mode === "mm") {
		await write(workspace, ".mmrc", "wrong-module\n")
		await write(workspace, ".mm.json", JSON.stringify({ modules: [{ path: "api", name: "API" }] }))
	}
	const manager = new ThreadWorktreeManager(path.join(temp, "storage"))
	await manager.configure({ mode: "git", mmPath, nodePath: "node" })
	return { workspace, root, manager }
}
beforeEach(async () => {
	temp = await fs.mkdtemp(path.join(os.tmpdir(), "cline-nested-submodules-"))
})
afterEach(async () => {
	vi.restoreAllMocks()
	await fs.rm(temp, { force: true, recursive: true })
}, 60_000)

for (const mode of ["git", "mm"] as const) {
	it(`${mode}: create, diff, bring, undo, try and remove nested relative-URL submodules`, async () => {
		const { workspace, root, manager } = await fixture(mode)
		const mapping = await manager.create("nested", "Nested", workspace)
		const module = mapping.modules[0]
		const child = path.join(module.path, "vendor", "nested child")
		const home = path.join(root, "vendor", "nested child")
		const originalHead = git(home, "rev-parse", "HEAD")
		expect(git(child, "branch", "--show-current")).toBe("")
		expect(git(module.path, "submodule", "status", "--recursive").split("\n")).toHaveLength(2)
		identity(child)
		await write(child, "committed.txt", "committed\n")
		git(child, "add", "committed.txt")
		git(child, "commit", "-m", "child commit")
		const head = git(child, "rev-parse", "HEAD")
		const middle = path.dirname(child)
		identity(middle)
		git(middle, "add", "nested child")
		git(middle, "commit", "-m", "move nested gitlink")
		git(module.path, "add", "vendor")
		git(module.path, "commit", "-m", "move vendor gitlink")
		await write(child, "staged.txt", "staged\n")
		git(child, "add", "staged.txt")
		await write(child, "file.txt", "working\n")
		await write(child, "new.txt", "untracked\n")
		git(module.path, "config", "diff.ignoreSubmodules", "all")
		git(module.path, "config", "submodule.vendor.ignore", "all")
		const index = git(child, "diff", "--cached")
		const diffs = await manager.diffs("nested")
		const descendant = diffs.find((diff) => diff.worktreePath === child)!
		expect(descendant.paths).toHaveLength(4)
		expect(descendant.patch).toContain("+committed")
		expect(git(child, "diff", "--cached")).toBe(index)
		expect((await manager.remove("nested")).warning).toContain("never copied here")
		expect((await manager.summary("nested")).loseOnRemove).toBeGreaterThan(0)
		await manager.bring("nested")
		expect(await read(home, "file.txt")).toBe("working\n")
		expect(await read(home, "staged.txt")).toBe("staged\n")
		expect(await read(home, "new.txt")).toBe("untracked\n")
		expect(git(home, "rev-parse", "HEAD")).toBe(head)
		expect((await manager.diffs("nested", true)).every((diff) => !diff.patch)).toBe(true)
		expect((await manager.undo("nested")).conflicts).toEqual([])
		expect(await read(home, "file.txt")).toBe("base\n")
		expect(git(home, "rev-parse", "HEAD")).toBe(originalHead)
		await expect(fs.access(path.join(home, "committed.txt"))).rejects.toThrow()
		if (mode === "mm") {
			execFileSync("node", [mmPath, "try", mapping.branch], { cwd: workspace, stdio: "pipe" })
			expect(await read(home, "file.txt")).toBe("working\n")
			execFileSync("node", [mmPath, "try"], { cwd: workspace, stdio: "pipe" })
			expect(await read(home, "file.txt")).toBe("base\n")
			await manager.assertPresent(mapping)
		}
		const result = await manager.takeOver("nested")
		expect(result.warning).toBeUndefined()
		expect(git(root, "branch", "--show-current")).toBe(mapping.branch)
		expect(git(home, "rev-parse", "HEAD")).toBe(head)
		expect(git(home, "show", ":staged.txt")).toBe("staged")
		expect(await read(home, "file.txt")).toBe("working\n")
		expect(await read(home, "new.txt")).toBe("untracked\n")
		expect((await manager.summary("nested")).loseOnRemove).toBe(0)
		expect((await manager.remove("nested")).warning).toBeUndefined()
		expect(await read(home, "new.txt")).toBe("untracked\n")
		expect(await manager.get("nested")).toBeUndefined()
	}, 120_000)

	it(`${mode}: detects staged-only data that differs from copied working files at any depth`, async () => {
		const { workspace, manager } = await fixture(mode)
		const mapping = await manager.create("staged", "Staged", workspace)
		const child = path.join(mapping.modules[0].path, "vendor", "nested child")
		await write(child, "file.txt", "staged version\n")
		git(child, "add", "file.txt")
		await write(child, "file.txt", "working version\n")
		await manager.bring("staged")
		expect((await manager.remove("staged")).warning).toContain("never copied here")
		expect((await manager.summary("staged")).loseOnRemove).toBeGreaterThan(0)
		expect(git(child, "show", ":file.txt")).toBe("staged version")
	}, 120_000)

	it(`${mode}: treats a missing descendant as unsafe instead of reading the enclosing repository`, async () => {
		const { workspace, manager } = await fixture(mode)
		const mapping = await manager.create("missing-child", "Missing child", workspace)
		await fs.rm(path.join(mapping.modules[0].path, "vendor", "nested child", ".git"), { force: true, recursive: true })
		await expect(manager.assertPresent(mapping)).rejects.toThrow("not a repository root")
		expect((await manager.remove("missing-child")).warning).toContain("never copied here")
	}, 120_000)
	it(`${mode}: copied nested edits remove safely, but later edits and commits in the leftover folder warn`, async () => {
		const { workspace, manager } = await fixture(mode)
		const mapping = await manager.create("later", "Later", workspace)
		const child = path.join(mapping.modules[0].path, "vendor", "nested child")
		await write(child, "file.txt", "copied\n")
		await manager.bring("later")
		expect((await manager.summary("later")).loseOnRemove).toBe(0)
		await write(child, "file.txt", "later\n")
		expect((await manager.remove("later")).warning).toContain("never copied here")
		await manager.undo("later")
		await manager.takeOver("later")
		identity(child)
		git(child, "commit", "--allow-empty", "-m", "leftover commit")
		expect((await manager.remove("later")).warning).toContain("leftover")
	}, 120_000)

	it(`${mode}: three-way undo in a descendant preserves later edits and its real index`, async () => {
		const { workspace, root, manager } = await fixture(mode)
		const mapping = await manager.create("conflict", "Conflict", workspace)
		const child = path.join(mapping.modules[0].path, "vendor", "nested child")
		const home = path.join(root, "vendor", "nested child")
		await write(child, "file.txt", "copied\n")
		await manager.bring("conflict")
		await write(home, "file.txt", "later home edit\n")
		await write(home, "staged.txt", "staged by user\n")
		git(home, "add", "staged.txt")
		const before = git(home, "diff", "--cached")
		const result = await manager.undo("conflict")
		expect(result.conflicts).toEqual([[mapping.modules[0].name, "vendor/nested child/file.txt"].filter(Boolean).join("/")])
		expect(await read(home, "file.txt")).toContain("<<<<<<<")
		expect(await read(home, "file.txt")).toContain("later home edit")
		expect(git(home, "diff", "--cached")).toBe(before)
	}, 120_000)
	it(`${mode}: a failed descendant transfer restores all repositories and their staged data`, async () => {
		const { workspace, root, manager } = await fixture(mode)
		const mapping = await manager.create("rollback", "Rollback", workspace)
		const child = path.join(mapping.modules[0].path, "vendor", "nested child")
		const home = path.join(root, "vendor", "nested child")
		identity(child)
		await write(mapping.modules[0].path, "file.txt", "parent edits\n")
		await write(child, "file.txt", "staged child\n")
		git(child, "add", "file.txt")
		await write(child, "file.txt", "working child\n")
		await write(child, "new.txt", "untracked child\n")
		const original = repositoryTools.git
		let failed = false
		vi.spyOn(repositoryTools, "git").mockImplementation(async (cwd, args, ...rest) => {
			if (
				!failed &&
				cwd === path.join(mapping.modules[0].workspacePath, "vendor", "nested child") &&
				args[0] === "stash" &&
				args[1] === "apply"
			) {
				failed = true
				throw new Error("injected descendant transfer failure")
			}
			return original(cwd, args, ...rest)
		})
		await expect(manager.takeOver("rollback")).rejects.toThrow("injected descendant transfer failure")
		expect(git(root, "branch", "--show-current")).toBe("main")
		expect(git(mapping.modules[0].path, "branch", "--show-current")).toBe(mapping.branch)
		expect(await read(mapping.modules[0].path, "file.txt")).toBe("parent edits\n")
		expect(await read(child, "file.txt")).toBe("working child\n")
		expect(git(child, "show", ":file.txt")).toBe("staged child")
		expect(await read(child, "new.txt")).toBe("untracked child\n")
		expect(await read(home, "file.txt")).toBe("base\n")
		expect(git(home, "status", "--porcelain")).toBe("")
	}, 120_000)
}

it("uses the nearest mm config, prefers .mm.json, and refuses free after module configuration changes", async () => {
	const { workspace, root, manager } = await fixture("mm")
	const mapping = await manager.create("config", "Config", root)
	expect(mapping.workspace).toBe(workspace)
	expect(mapping.modules.map((module) => module.name)).toEqual(["api"])
	await write(workspace, ".mm.json", '{"modules":["other"]}')
	await expect(manager.remove("config", true)).rejects.toThrow("configuration changed")
	await fs.access(mapping.modules[0].path)
}, 120_000)

it("mm: configured modules may themselves be submodules with .git files", async () => {
	const { workspace, root, manager } = await fixture("mm", true)
	const mapping = await manager.create("configured", "Configured submodule", workspace)
	await manager.assertPresent(mapping)
	const child = path.join(mapping.modules[0].path, "vendor", "nested child")
	await write(child, "file.txt", "configured submodule edit\n")
	expect((await manager.remove("configured")).warning).toContain("never copied here")
	await manager.bring("configured")
	expect(await read(path.join(root, "vendor", "nested child"), "file.txt")).toBe("configured submodule edit\n")
	expect((await manager.remove("configured")).warning).toBeUndefined()
}, 120_000)

it("git: initializes a deinitialized descendant from its local cache", async () => {
	const { workspace, root, manager } = await fixture("git")
	git(root, "submodule", "deinit", "-f", "vendor")
	const mapping = await manager.create("deinitialized", "Deinitialized", workspace)
	const child = path.join(mapping.modules[0].path, "vendor", "nested child")
	expect(await read(child, "file.txt")).toBe("base\n")
	expect(git(child, "branch", "--show-current")).toBe("")
	await manager.remove("deinitialized")
}, 120_000)

it("rejects overlapping mm module roots before creating an isolate", async () => {
	const { workspace, manager } = await fixture("mm")
	await write(workspace, ".mm.json", '{"modules":["api","api/vendor"]}')
	expect((await manager.availability(workspace)).reason).toContain("both a repository and its descendant")
	await expect(manager.create("overlap", "Overlap", workspace)).rejects.toThrow("both a repository and its descendant")
	expect(await manager.get("overlap")).toBeUndefined()
}, 120_000)

it("never treats a new embedded repository as a copied file", async () => {
	const { workspace, manager } = await fixture("git")
	const mapping = await manager.create("embedded", "Embedded", workspace)
	git(temp, "clone", path.join(temp, "leaf"), path.join(mapping.cwd, "extra"))
	await expect(manager.diffs("embedded")).rejects.toThrow("added or removed submodules")
	expect((await manager.remove("embedded")).warning).toContain("never copied here")
	await fs.access(path.join(mapping.cwd, "extra", "file.txt"))
}, 120_000)

it("protects descendant commits with no net file changes even when Git ignores submodules", async () => {
	const { workspace, manager } = await fixture("git")
	const mapping = await manager.create("empty-child", "Empty child commit", workspace)
	const child = path.join(mapping.modules[0].path, "vendor", "nested child")
	identity(child)
	git(child, "commit", "--allow-empty", "-m", "unpublished child commit")
	git(path.dirname(child), "config", "submodule.nested child.ignore", "all")
	git(mapping.modules[0].path, "config", "submodule.vendor.ignore", "all")
	expect((await manager.summary("empty-child")).loseOnRemove).toBeGreaterThan(0)
	expect((await manager.remove("empty-child")).warning).toContain("never copied here")
	await manager.bring("empty-child")
	expect((await manager.summary("empty-child")).loseOnRemove).toBe(0)
	expect((await manager.remove("empty-child")).warning).toBeUndefined()
}, 120_000)
