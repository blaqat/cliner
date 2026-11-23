import { execFileSync, spawn } from "node:child_process"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { NO_COMMITS, NOT_A_REPOSITORY, WORKTREES_OFF, WORKTREES_OFF_HERE, worktreeFixFor } from "@shared/thread-worktrees"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { worktreeFix } from "../automations/automation-precheck"
import { alive, owner, storageLock } from "./storage-lock"
import { mmPath } from "./temp-project.test-support"
import { ThreadWorktreeManager, taskWorktreeKey } from "./thread-worktree-manager"

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim()
let temp: string
let workspace: string
let storage: string
let manager: ThreadWorktreeManager
const write = (dir: string, file: string, content: string) => fs.writeFile(path.join(dir, file), content)
const read = (dir: string, file = "file.txt") => fs.readFile(path.join(dir, file), "utf8")
async function repo(dir: string) {
	await fs.mkdir(dir, { recursive: true })
	git(dir, "init", "-b", "main")
	git(dir, "config", "user.name", "Worktree test")
	git(dir, "config", "user.email", "test@example.invalid")
	await write(dir, "file.txt", "base\n")
	git(dir, "add", ".")
	git(dir, "commit", "-m", "base")
}
beforeEach(async () => {
	temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "cline-thread-worktrees-")))
	workspace = path.join(temp, "workspace")
	storage = path.join(temp, "storage")
	manager = new ThreadWorktreeManager(storage)
	await repo(workspace)
	await manager.configure({ mode: "git", mmPath, nodePath: "node" })
}, 60_000)
afterEach(async () => {
	await fs.rm(temp, { recursive: true, force: true })
}, 60_000)

it("reuses a task worktree across windows and waits for all its threads before cleanup", async () => {
	const other = new ThreadWorktreeManager(storage)
	const id = taskWorktreeKey("shared-task")
	const task = { id: "shared-task", beforeCreate: vi.fn(async () => {}) }
	const [mapping, same] = await Promise.all([
		manager.create(id, "Shared task", workspace, false, task),
		other.create(id, "Shared task", workspace, false, task),
	])
	expect(same).toEqual(mapping)
	expect(task.beforeCreate).toHaveBeenCalledOnce()
	expect((await other.get(id))?.taskGroupId).toBe(task.id)
	const releaseFirst = await manager.acquireSessionLease("first", async () => ({ mapping }))
	const releaseSecond = await other.acquireSessionLease("second", async () => ({ mapping }))
	try {
		await write(mapping.cwd, "first.txt", "first thread\n")
		await write(mapping.cwd, "second.txt", "second thread\n")
		expect(await other.summary(id)).toMatchObject({ changedFiles: 2 })
		await expect(manager.remove(id, true)).rejects.toThrow("every thread")
		await releaseFirst()
		await expect(manager.bring(id)).rejects.toThrow("every thread")
	} finally {
		await releaseFirst()
		await releaseSecond()
	}
	const reopened = new ThreadWorktreeManager(storage)
	expect(await reopened.workspaceRoute("second")).toEqual({ home: workspace })
	expect(await reopened.bring(id)).toMatchObject({ files: 2 })
	expect(await read(workspace, "second.txt")).toBe("second thread\n")
	await reopened.remove(id)
	expect(await manager.get(id)).toBeUndefined()
	const recreated = await manager.create(id, "Shared task", workspace, false, task)
	expect(recreated.branch).not.toBe(mapping.branch)
})

it.each([
	["prints the former text output", 'console.log("  1 api /workspace/api")'],
	["does not recognize the option", 'console.error("unknown option --json"); process.exitCode = 1'],
	["fails before reaching the command", 'console.error("mm: no .mm.json found"); process.exitCode = 1'],
])("blocks Git fallback when old mm %s", async (_label, source) => {
	const oldMm = path.join(temp, "old-mm.js")
	await fs.writeFile(oldMm, source)
	await manager.configure({ mode: "git", mmPath: oldMm, nodePath: "node" })
	const reason = `This mm doesn't list its modules yet. Update mm.js. mm.js path: ${oldMm}`
	expect(await manager.availability(workspace)).toMatchObject({ mode: "mm", available: false, reason })
	await expect(manager.create("old-mm", "Old mm", workspace)).rejects.toThrow(reason)
	expect(await manager.get("old-mm")).toBeUndefined()
})

it("reports unset mm, a missing mm script, and missing Node with paths to fix", async () => {
	await manager.configure({ mode: "mm", mmPath: "", nodePath: "node" })
	expect((await manager.availability(workspace)).reason).toBe(
		"Set the path to mm.js in Worktrees settings. mm.js path: (not set)",
	)
	const missingMm = path.join(temp, "missing.js")
	await manager.configure({ mode: "mm", mmPath: missingMm, nodePath: "node" })
	expect((await manager.availability(workspace)).reason).toContain(
		`Couldn't find mm.js. Check its path in Worktrees settings. mm.js path: ${missingMm}`,
	)
	const missingNode = path.join(temp, "missing-node")
	await manager.configure({ mode: "git", mmPath, nodePath: missingNode })
	expect((await manager.availability(workspace)).reason).toBe(
		`Couldn't run Node. Check its path in Worktrees settings. Node path: ${missingNode}. mm.js path: ${mmPath}`,
	)
})

it("names the switch that's off, or the folder's git problem, and where each is fixed", async () => {
	await manager.configure({ mode: "off", mmPath, nodePath: "node" })
	expect(await manager.availability(workspace)).toMatchObject({
		available: false,
		fix: "mode",
		reason: "Worktrees are off. Choose Git worktree or mm.",
	})
	expect(await manager.availability(workspace, true)).toMatchObject({
		fix: "mode",
		reason: "Worktrees are off. Choose Git worktree or mm.",
	})
	await manager.configure({ mode: "git", mmPath: "", nodePath: "node" })
	expect(await manager.availability(workspace, true)).toMatchObject({
		available: false,
		fix: "workspace",
		reason: "Worktrees are off for this workspace. Turn on Use worktrees in this workspace.",
	})
	const plain = path.join(temp, "plain")
	await fs.mkdir(plain)
	expect(await manager.availability(plain)).toMatchObject({ available: false, fix: "repository" })
	expect((await manager.availability(plain)).reason).toContain("not a git repository")
	git(plain, "init", "-b", "main")
	expect(await manager.availability(plain)).toMatchObject({
		available: false,
		fix: "commit",
		reason: "This repository does not have any commits yet. Make a first commit.",
	})
	await manager.configure({ mode: "mm", mmPath: "", nodePath: "node" })
	expect(await manager.availability(workspace)).toMatchObject({ available: false, fix: "mm" })
})

it.each([
	[WORKTREES_OFF, "mode", "worktrees"],
	[WORKTREES_OFF_HERE, "workspace", "worktrees"],
	["Couldn't find mm.js. Check its path in Worktrees settings. mm.js path: /x/mm.js", "mm", "worktrees"],
	[NOT_A_REPOSITORY, "repository", "repository"],
	[NO_COMMITS, "commit", "commit"],
	// Reasons stored before this wording keep their fix.
	["Worktrees are off for this workspace", "workspace", "worktrees"],
])("links %s to its fix here and in automations", (reason, fix, automationFix) => {
	expect(worktreeFixFor(reason)).toBe(fix)
	expect(worktreeFix(reason)).toBe(automationFix)
})

it("hints at mm config in the folder, checks mm.js is there and expands ~ in paths", async () => {
	expect(await manager.setupHints(workspace)).toEqual({ mmConfigFile: undefined, mmFound: true })
	await write(workspace, ".mmrc", "api\n")
	expect((await manager.setupHints(workspace)).mmConfigFile).toBe(".mmrc")
	await write(workspace, ".mm.json", "{}")
	expect((await manager.setupHints(workspace)).mmConfigFile).toBe(".mm.json")
	await manager.configure({ mode: "mm", mmPath: path.join(temp, "missing.js"), nodePath: "node" })
	expect((await manager.setupHints(workspace)).mmFound).toBe(false)
	await manager.configure({ mode: "mm", mmPath: "", nodePath: "node" })
	expect((await manager.setupHints(workspace)).mmFound).toBeUndefined()
	await manager.configure({ mode: "mm", mmPath: " ~/tools/mm.js ", nodePath: "~" })
	expect(await manager.settings()).toEqual({
		mode: "mm",
		mmPath: path.join(os.homedir(), "tools/mm.js"),
		nodePath: os.homedir(),
	})
})

it("merges a changed field into what's saved, so two windows don't undo each other", async () => {
	// Another window shares this storage folder.
	const other = new ThreadWorktreeManager(storage)
	await manager.configure({ mmPath: path.join(temp, "window-b-mm.js") })
	// This window's next save changes only the Node path; it must not bring back the mm.js it last saw.
	await other.configure({ nodePath: "/window-a/node" })
	expect(await manager.settings()).toEqual({
		mode: "git",
		mmPath: path.join(temp, "window-b-mm.js"),
		nodePath: "/window-a/node",
	})
	await Promise.all([manager.configure({ mode: "mm" }), other.configure({ nodePath: "node" })])
	expect(await manager.settings()).toMatchObject({ mode: "mm", nodePath: "node" })
	await expect(manager.configure({ mode: "bogus" as never })).rejects.toThrow("Invalid worktree settings")
	await expect(manager.configure({ nodePath: 3 as never })).rejects.toThrow("Invalid worktree settings")
})

it("caches discovery until settings, an explicit refresh, or create request new results", async () => {
	expect(await manager.availability(workspace)).toMatchObject({ mode: "git", available: true })
	await write(workspace, ".mm.json", "{")
	expect(await manager.availability(workspace)).toMatchObject({ mode: "git", available: true })
	const fresh = await manager.availability(workspace, false, true)
	expect(fresh).toMatchObject({ mode: "mm", available: false })
	expect(fresh.reason).toContain(".mm.json is not valid JSON")
	expect(fresh.reason).toContain(`Config: ${path.join(workspace, ".mm.json")}`)
	expect(fresh.reason).toContain(`mm.js path: ${mmPath}`)

	await fs.rm(path.join(workspace, ".mm.json"))
	expect(await manager.availability(workspace)).toEqual(fresh)
	await manager.configure(await manager.settings())
	expect(await manager.availability(workspace)).toMatchObject({ mode: "git", available: true })
	await write(workspace, ".mm.json", "{")
	await expect(manager.create("broken-mm", "Broken mm", workspace)).rejects.toThrow(".mm.json is not valid JSON")
	expect(await manager.get("broken-mm")).toBeUndefined()
})

it("rejects duplicate isolate folders and modules that escape the workspace", async () => {
	await repo(path.join(workspace, "a", "api"))
	await repo(path.join(workspace, "b", "api"))
	await write(workspace, ".mm.json", '["a/api","b/api"]')
	expect((await manager.availability(workspace)).reason).toContain("share the isolate folder name api")
	await write(workspace, ".mm.json", '["../outside"]')
	expect((await manager.availability(workspace, false, true)).reason).toContain("must be inside the workspace")
})

it("creates a git worktree, persists its mapping, reuses it and removes it", async () => {
	const mapping = await manager.create("thread-1", "Fix the login", workspace)
	expect(git(mapping.cwd, "branch", "--show-current")).toBe(mapping.branch)
	expect(mapping.branch).toMatch(/^cline\/fix-the-login-/)
	const reloaded = new ThreadWorktreeManager(storage)
	expect(await reloaded.get("thread-1")).toEqual(mapping)
	expect(await reloaded.create("thread-1", "renamed", workspace)).toEqual(mapping)
	await reloaded.remove("thread-1")
	expect(await reloaded.get("thread-1")).toBeUndefined()
	expect(git(workspace, "worktree", "list")).not.toContain(mapping.cwd)
}, 60_000)
it("diffs committed, staged, unstaged and untracked files without changing the index", async () => {
	const m = await manager.create("diff", "Diff", workspace)
	await write(m.cwd, "file.txt", "commit\n")
	git(m.cwd, "commit", "-am", "change")
	await write(m.cwd, "staged.txt", "staged\n")
	git(m.cwd, "add", "staged.txt")
	await write(m.cwd, "file.txt", "unstaged\n")
	await write(m.cwd, "new.txt", "new\n")
	const before = git(m.cwd, "diff", "--cached")
	const [diff] = await manager.diffs("diff")
	expect(diff.paths.sort()).toEqual(["file.txt", "new.txt", "staged.txt"])
	expect(diff.patch).toContain("+unstaged")
	expect(git(m.cwd, "diff", "--cached")).toBe(before)
}, 60_000)
it("brings changes here, saves the patch and undoes a clean bring-in", async () => {
	const m = await manager.create("bring", "Bring", workspace)
	await write(m.cwd, "file.txt", "brought\n")
	await write(m.cwd, "new.txt", "new\n")
	await manager.bring("bring")
	expect(await read(workspace)).toBe("brought\n")
	const saved = (await manager.get("bring"))!.bringIns[0].patches[0].file
	expect(await fs.readFile(saved, "utf8")).toContain("+brought")
	expect((await manager.undo("bring")).conflicts).toEqual([])
	expect(await read(workspace)).toBe("base\n")
	await expect(fs.access(path.join(workspace, "new.txt"))).rejects.toThrow()
}, 60_000)
it("explains a bring-in that clashes with the workspace's own uncommitted edits, and changes nothing", async () => {
	const m = await manager.create("clash", "Clash", workspace)
	await write(m.cwd, "file.txt", "from the thread\n")
	await write(workspace, "file.txt", "edited in the workspace\n")
	await expect(manager.bring("clash")).rejects.toThrow(
		"Your workspace has its own changes to `file.txt` that clash with this thread's. Commit, stash or undo them in your workspace, then copy again.",
	)
	expect(await read(workspace)).toBe("edited in the workspace\n")
	expect((await manager.get("clash"))!.bringIns).toEqual([])
}, 60_000)
it("undo reports overlapping later edits as conflicts and preserves the real index", async () => {
	const m = await manager.create("conflict", "Conflict", workspace)
	await write(m.cwd, "file.txt", "brought\n")
	await manager.bring("conflict")
	await write(workspace, "file.txt", "later edit\n")
	await write(workspace, "user-staged.txt", "staged by user\n")
	git(workspace, "add", "user-staged.txt")
	const before = git(workspace, "diff", "--cached")
	const result = await manager.undo("conflict")
	expect(result.conflicts).toEqual(["file.txt"])
	expect(await read(workspace)).toContain("<<<<<<<")
	expect(await read(workspace)).toContain("later edit")
	expect(git(workspace, "diff", "--cached")).toBe(before)
}, 60_000)
it("warns before taking over a dirty workspace and leaves both branches attached", async () => {
	const m = await manager.create("dirty", "Dirty", workspace)
	await write(workspace, "file.txt", "user change\n")
	expect((await manager.takeOver("dirty")).warning).toContain("workspace has uncommitted changes")
	expect(git(workspace, "branch", "--show-current")).toBe("main")
	expect(git(m.cwd, "branch", "--show-current")).toBe(m.branch)
}, 60_000)
it("takes over a committed branch without deleting the isolate", async () => {
	const m = await manager.create("take", "Take", workspace)
	await write(m.cwd, "file.txt", "committed\n")
	git(m.cwd, "commit", "-am", "change")
	expect((await manager.takeOver("take")).warning).toBeUndefined()
	expect(git(workspace, "branch", "--show-current")).toBe(m.branch)
	expect(await read(workspace)).toBe("committed\n")
	await fs.access(m.cwd)
}, 60_000)
it("switches the workspace to the branch carrying the worktree's uncommitted edits along", async () => {
	const m = await manager.create("carry", "Carry", workspace)
	await write(m.cwd, "file.txt", "committed\n")
	git(m.cwd, "commit", "-am", "change")
	await write(m.cwd, "file.txt", "committed\nand edited\n")
	await write(m.cwd, "untracked.txt", "new\n")
	const result = await manager.takeOver("carry")
	expect(result.warning).toBeUndefined()
	expect(result.files).toBe(2)
	expect(result.message).toBe("Your workspace is on this branch now, with its 2 uncommitted files")
	expect(git(workspace, "branch", "--show-current")).toBe(m.branch)
	expect(await read(workspace)).toBe("committed\nand edited\n")
	expect(await read(workspace, "untracked.txt")).toBe("new\n")
	// The carrier stash is gone and the leftover folder is clean and detached.
	expect(git(workspace, "stash", "list")).toBe("")
	expect(git(m.cwd, "status", "--porcelain")).toBe("")
	expect(git(m.cwd, "branch", "--show-current")).toBe("")
	const summary = await manager.summary("carry")
	expect(summary).toMatchObject({ takenOver: true, loseOnRemove: 0, workspaceDirty: true })
	// Nothing would be lost, so the leftover folder goes without asking.
	expect((await manager.remove("carry")).message).toBe("Removed the leftover worktree folder")
	expect(await manager.get("carry")).toBeUndefined()
	expect(await read(workspace)).toBe("committed\nand edited\n")
}, 60_000)
it("asks before removing a leftover folder that has edits of its own", async () => {
	const m = await manager.create("leftover", "Leftover", workspace)
	await manager.takeOver("leftover")
	await write(m.cwd, "file.txt", "edited after the switch\n")
	expect((await manager.remove("leftover")).warning).toContain("leftover worktree folder has edits")
	expect((await manager.summary("leftover")).loseOnRemove).toBe(1)
}, 60_000)
it("summarizes what changed, what's copied and what removal would lose", async () => {
	const m = await manager.create("sum", "Sum", workspace)
	expect(await manager.summary("sum")).toMatchObject({
		changedFiles: 0,
		commits: 0,
		uncopiedFiles: 0,
		canUndo: false,
		loseOnRemove: 0,
		workspaceDirty: false,
		takenOver: false,
	})
	await write(m.cwd, "file.txt", "committed\n")
	git(m.cwd, "commit", "-am", "change")
	await write(m.cwd, "new.txt", "new\n")
	expect(await manager.summary("sum")).toMatchObject({
		changedFiles: 2,
		commits: 1,
		uncommittedFiles: 1,
		uncopiedFiles: 2,
		copied: false,
		canUndo: false,
		loseOnRemove: 2,
	})
	expect(await manager.bring("sum")).toMatchObject({ files: 2, message: "Copied 2 files into your workspace" })
	expect(await manager.summary("sum")).toMatchObject({
		changedFiles: 2,
		uncopiedFiles: 0,
		copied: true,
		canUndo: true,
		loseOnRemove: 0,
		workspaceDirty: true,
	})
	await write(m.cwd, "new.txt", "newer\n")
	expect(await manager.summary("sum")).toMatchObject({ uncopiedFiles: 1, loseOnRemove: 1 })
	await manager.undo("sum")
	expect(await manager.summary("sum")).toMatchObject({ copied: false, canUndo: false, workspaceDirty: false })
}, 60_000)
it("warns on removal of changes never copied here, including later changes", async () => {
	const m = await manager.create("remove", "Remove", workspace)
	await write(m.cwd, "file.txt", "first\n")
	expect((await manager.remove("remove")).warning).toContain("never copied here")
	await manager.bring("remove")
	await write(m.cwd, "file.txt", "later\n")
	expect((await manager.remove("remove")).warning).toContain("never copied here")
	await manager.remove("remove", true)
	expect(await manager.get("remove")).toBeUndefined()
}, 60_000)
it("detects settled/done threads, persists settings, honors workspace off", async () => {
	await manager.create("settled", "Settled", workspace)
	await manager.create("active", "Active", workspace)
	expect((await manager.settled([{ id: "settled", isSettled: true }, { id: "active" }])).map((m) => m.threadId)).toEqual([
		"settled",
	])
	expect((await manager.settled([], ["active"])).map((m) => m.threadId)).toEqual(["active"])
	expect((await manager.availability(workspace, true)).available).toBe(false)
	await expect(manager.create("off", "Off", workspace, true)).rejects.toThrow("off")
	expect((await new ThreadWorktreeManager(storage).settings()).mode).toBe("git")
}, 60_000)
// Real mm is executed only against this temporary two-repo project.
describe("mm integration", () => {
	beforeEach(async () => {
		await fs.rm(workspace, { recursive: true, force: true })
		await repo(path.join(workspace, "api"))
		await repo(path.join(workspace, "web"))
		await write(workspace, ".mmrc", '{"modules":["api","web"]}')
	}, 60_000)
	it("keeps worktrees off when Mode is Off, even with mm.js set in an mm workspace", async () => {
		await manager.configure({ mode: "off", mmPath, nodePath: "node" })
		expect(await manager.availability(workspace)).toMatchObject({ mode: "off", available: false, fix: "mode" })
		await expect(manager.create("off", "Off", workspace)).rejects.toThrow("Worktrees are off.")
	})
	it("auto-selects mm, creates both module worktrees and verifies real mm free", async () => {
		expect(await manager.availability(workspace)).toMatchObject({ mode: "mm", available: true, modules: ["api", "web"] })
		const m = await manager.create("mm", "Two modules", workspace)
		expect(m.mode).toBe("mm")
		for (const module of m.modules) expect(git(module.path, "branch", "--show-current")).toBe(m.branch)
		await manager.remove("mm")
		for (const module of m.modules) await expect(fs.access(module.path)).rejects.toThrow()
	}, 60_000)
	it("brings and undoes module-prefixed diffs, reporting later conflicts", async () => {
		const m = await manager.create("mm-bring", "Modules", workspace)
		for (const module of m.modules) await write(module.path, "file.txt", `${module.name} work\n`)
		expect((await manager.diffs("mm-bring")).flatMap((d) => d.paths)).toEqual(["api/file.txt", "web/file.txt"])
		await manager.bring("mm-bring")
		for (const module of m.modules) expect(await read(module.workspacePath)).toBe(`${module.name} work\n`)
		expect((await manager.undo("mm-bring")).conflicts).toEqual([])
		for (const module of m.modules) expect(await read(module.workspacePath)).toBe("base\n")
		await manager.bring("mm-bring")
		await write(workspace, "api/file.txt", "later user edit\n")
		expect((await manager.undo("mm-bring")).conflicts).toEqual(["api/file.txt"])
		expect(await read(path.join(workspace, "web"))).toBe("base\n")
	}, 60_000)
})

it("brings successive edits as separate saved patches and undoes them in order", async () => {
	const mapping = await manager.create("successive", "Successive", workspace)
	await write(mapping.cwd, "file.txt", "first\n")
	await manager.bring("successive")
	await write(mapping.cwd, "file.txt", "second\n")
	await manager.bring("successive")
	expect(await read(workspace)).toBe("second\n")
	expect((await manager.get("successive"))!.bringIns).toHaveLength(2)
	await manager.undo("successive")
	expect(await read(workspace)).toBe("first\n")
	await manager.undo("successive")
	expect(await read(workspace)).toBe("base\n")
}, 60_000)
it("refuses stale mappings instead of using the original workspace", async () => {
	const mapping = await manager.create("missing", "Missing", workspace)
	git(workspace, "worktree", "remove", mapping.cwd)
	await expect(manager.create("missing", "Missing", workspace)).rejects.toThrow("Worktree missing")
}, 60_000)

it("preserves upstream .worktreeinclude copying for a thread isolate", async () => {
	await write(workspace, ".gitignore", "local.env\n")
	await write(workspace, ".worktreeinclude", "local.env\n")
	await write(workspace, "local.env", "LOCAL_TEST_VALUE=example\n")
	git(workspace, "add", ".gitignore", ".worktreeinclude")
	git(workspace, "commit", "-m", "worktree include")
	const mapping = await manager.create("include", "Include", workspace)
	expect(await read(mapping.cwd, "local.env")).toBe("LOCAL_TEST_VALUE=example\n")
}, 60_000)

// Mutate after capture to model an editor changing the isolate mid-bring.
for (const mode of ["git", "mm"] as const) {
	it(`${mode}: removal checks the exact trees captured by bring`, async () => {
		if (mode === "mm") {
			await fs.rm(workspace, { recursive: true, force: true })
			await repo(path.join(workspace, "api"))
			await repo(path.join(workspace, "web"))
			await write(workspace, ".mmrc", "api\nweb\n")
		}
		const mapping = await manager.create("capture", "Capture", workspace)
		for (const module of mapping.modules) await write(module.path, "file.txt", "captured\n")
		const original = manager.diffs.bind(manager)
		const spy = vi.spyOn(manager, "diffs").mockImplementationOnce(async (...args) => {
			const captured = await original(...args)
			for (const module of mapping.modules) await write(module.path, "file.txt", "later\n")
			return captured
		})
		await manager.bring("capture")
		spy.mockRestore()
		for (const module of mapping.modules) expect(await read(module.workspacePath)).toBe("captured\n")
		expect((await manager.remove("capture")).warning).toContain("never copied here")
		for (const module of mapping.modules) expect(await read(module.path)).toBe("later\n")
	}, 60_000)
}

for (const mode of ["git", "mm"] as const) {
	it(`${mode}: removal preserves staged-only versions even after bringing working files`, async () => {
		if (mode === "mm") {
			await fs.rm(workspace, { recursive: true, force: true })
			await repo(path.join(workspace, "api"))
			await repo(path.join(workspace, "web"))
			await write(workspace, ".mmrc", "api\nweb\n")
		}
		const mapping = await manager.create("staged-only", "Staged", workspace)
		for (const module of mapping.modules) {
			await write(module.path, "file.txt", "staged only\n")
			git(module.path, "add", "file.txt")
			await write(module.path, "file.txt", "base\n")
		}
		expect((await manager.remove("staged-only")).warning).toContain("never copied here")
		for (const module of mapping.modules) await write(module.path, "file.txt", "working files\n")
		await manager.bring("staged-only")
		expect((await manager.remove("staged-only")).warning).toContain("never copied here")
		for (const module of mapping.modules) expect(git(module.path, "show", ":file.txt")).toBe("staged only")
	}, 60_000)
}

for (const mode of ["git", "mm"] as const) {
	it(`${mode}: shared leases block every destructive action and serialize journals`, async () => {
		if (mode === "mm") {
			await fs.rm(workspace, { recursive: true, force: true })
			await repo(path.join(workspace, "api"))
			await repo(path.join(workspace, "web"))
			await write(workspace, ".mmrc", "api\nweb\n")
		}
		const mapping = await manager.create("shared", "Shared", workspace)
		const other = new ThreadWorktreeManager(storage)
		const release = await manager.acquireSessionLease("shared")
		try {
			await expect(other.acquireSessionLease("shared")).rejects.toThrow("active in another window")
			for (const action of [
				() => other.remove("shared", true),
				() => other.bring("shared"),
				() => other.undo("shared"),
				() => other.takeOver("shared"),
			]) {
				await expect(action()).rejects.toThrow("active in another window")
			}
		} finally {
			await release()
		}
		for (const module of mapping.modules) await write(module.path, "file.txt", "shared\n")
		await Promise.all([manager.bring("shared"), other.bring("shared")])
		expect((await manager.get("shared"))!.bringIns).toHaveLength(1)
		await Promise.all([manager.undo("shared"), other.undo("shared")])
		for (const module of mapping.modules) expect(await read(module.workspacePath)).toBe("base\n")
	}, 60_000)
}
it("serializes separate processes and recovers dead lock owners", async () => {
	const modulePath = path.resolve(import.meta.dirname, "storage-lock.ts")
	const child = spawn(
		"bun",
		[
			"-e",
			`import { alive, owner, storageLock } from ${JSON.stringify(modulePath)};
 const release = await storageLock(${JSON.stringify(storage)});
 console.log("locked");
 for await (const data of process.stdin) { break; }
 await release();`,
		],
		{ stdio: ["pipe", "pipe", "pipe"] },
	)
	const exited = new Promise<void>((resolve, reject) => {
		child.on("error", reject)
		child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`child exit ${code}`))))
	})
	try {
		await new Promise<void>((resolve, reject) => {
			child.stdout.once("data", () => resolve())
			child.once("exit", () => reject(new Error("child exited before locking")))
		})
		const lock = path.join(storage, "mutation.lock")
		const old = new Date(Date.now() - 120_000)
		await fs.lutimes(lock, old, old)
		let entered = false
		const waiting = storageLock(storage).then(async (release) => {
			entered = true
			await release()
		})
		await new Promise((resolve) => setTimeout(resolve, 100))
		expect(entered).toBe(false)
		child.stdin.end("release")
		await exited
		await waiting
		expect(entered).toBe(true)
	} finally {
		child.kill()
	}
	const lock = path.join(storage, "mutation.lock")
	await fs.mkdir(lock)
	await fs.writeFile(path.join(lock, "owner.json"), JSON.stringify({ pid: 2147483647, timestamp: Date.now(), token: "dead" }))
	const release = await storageLock(storage)
	await release()
}, 60_000)
it("refreshes a session lease and recovers a dead owner", async () => {
	const release = await manager.acquireSessionLease("heartbeat")
	const files = await fs.readdir(path.join(storage, "leases"))
	const file = path.join(storage, "leases", files[0])
	const before = JSON.parse(await fs.readFile(file, "utf8"))
	try {
		await vi.waitFor(
			async () => expect(JSON.parse(await fs.readFile(file, "utf8")).timestamp).toBeGreaterThan(before.timestamp),
			{ timeout: 10_000, interval: 100 },
		)
	} finally {
		await release()
	}
	await fs.writeFile(file, JSON.stringify({ ...before, pid: 2147483647, timestamp: Date.now() - 120_000 }))
	const recovered = await new ThreadWorktreeManager(storage).acquireSessionLease("heartbeat")
	await recovered()
}, 60_000)

for (const mode of ["git", "mm"] as const) {
	it(`${mode}: removal requires confirmation when the real index cannot be inspected`, async () => {
		if (mode === "mm") {
			await fs.rm(workspace, { recursive: true, force: true })
			await repo(path.join(workspace, "api"))
			await repo(path.join(workspace, "web"))
			await write(workspace, ".mmrc", "api\nweb\n")
		}
		const mapping = await manager.create("index-error", "Index error", workspace)
		for (const module of mapping.modules) await write(module.path, "file.txt", "brought\n")
		await manager.bring("index-error")
		const module = mapping.modules[0]
		await fs.writeFile(path.resolve(module.path, git(module.path, "rev-parse", "--git-path", "index")), "invalid index")
		expect((await manager.remove("index-error")).warning).toContain("never copied here")
		expect(await manager.get("index-error")).toBeDefined()
		await fs.access(mapping.cwd)
	}, 60_000)
}

it("renews and releases leases while a long mutation holds the global lock", async () => {
	const release = await manager.acquireSessionLease("renewal")
	const file = path.join(storage, "leases", (await fs.readdir(path.join(storage, "leases")))[0])
	const before = JSON.parse(await fs.readFile(file, "utf8"))
	const unlock = await storageLock(storage)
	try {
		await vi.waitFor(
			async () => expect(JSON.parse(await fs.readFile(file, "utf8")).timestamp).toBeGreaterThan(before.timestamp),
			{ timeout: 10_000 },
		)
		await release()
		expect(await fs.readdir(path.join(storage, "leases"))).toEqual([])
	} finally {
		await unlock()
		await release()
	}
}, 60_000)

it("does not reclaim an old lease belonging to a live child process", async () => {
	const child = spawn("bun", ["-e", 'console.log("ready"); setInterval(() => {}, 1000)'], { stdio: ["ignore", "pipe", "pipe"] })
	const exited = new Promise((resolve) => child.once("exit", resolve))
	await new Promise((resolve) => child.stdout.once("data", resolve))
	const release = await manager.acquireSessionLease("live-child")
	await release()
	const { createHash } = await import("node:crypto")
	const file = path.join(storage, "leases", `${createHash("sha256").update("live-child").digest("hex")}.json`)
	await fs.writeFile(file, JSON.stringify({ pid: child.pid, token: "child", timestamp: Date.now() - 120_000 }))
	try {
		await expect(manager.acquireSessionLease("live-child")).rejects.toThrow("active in another window")
		await expect(manager.assertIdle("live-child")).rejects.toThrow("active in another window")
	} finally {
		child.kill()
		await exited
	}
	const recovered = await manager.acquireSessionLease("live-child")
	await recovered()
}, 60_000)

it("recognizes PID reuse and fences a replaced lock owner", async () => {
	expect(await alive({ ...owner(), processStart: `${process.platform === "win32" ? "ticks" : "ps-utc"}:different` })).toBe(
		false,
	)
	const release = await storageLock(storage)
	await fs.rm(path.join(storage, "mutation.lock"), { recursive: true })
	const successor = await storageLock(storage)
	expect(() => release.assertOwned()).toThrow("ownership was lost")
	await release()
	await successor.assertOwned()
	await successor()
}, 60_000)

it("fences removal if ownership changes during worktree inspection", async () => {
	const mapping = await manager.create("fenced", "Fenced", workspace)
	const original = manager.diffs.bind(manager)
	let successor: Awaited<ReturnType<typeof storageLock>> | undefined
	vi.spyOn(manager, "diffs").mockImplementationOnce(async (...args) => {
		const captured = await original(...args)
		await fs.rm(path.join(storage, "mutation.lock"), { recursive: true })
		successor = await storageLock(storage)
		return captured
	})
	try {
		await expect(manager.remove("fenced")).rejects.toThrow("ownership was lost")
		await fs.access(mapping.cwd)
		expect(await manager.get("fenced")).toEqual(mapping)
		await successor?.assertOwned()
	} finally {
		await successor?.()
	}
}, 60_000)

describe("worktree removal safety", () => {
	async function withSubmodule() {
		const upstream = path.join(temp, "upstream")
		await repo(upstream)
		git(workspace, "-c", "protocol.file.allow=always", "submodule", "add", upstream, "vendor/lib")
		git(workspace, "commit", "-am", "Add submodule")
		const mapping = await manager.create("safety", "Safety", workspace)
		return { mapping, child: path.join(mapping.cwd, "vendor/lib"), source: path.join(workspace, "vendor/lib") }
	}

	it("keeps a symlinked destination out of the failed-creation journal", async () => {
		const existing = path.join(temp, "other-worktree")
		git(workspace, "worktree", "add", "-b", "other", existing)
		await write(existing, "file.txt", "dirty\n")
		const dest = path.join(workspace, ".worktrees", "reuse-d9c0d34144")
		await fs.mkdir(path.dirname(dest))
		await fs.symlink(existing, dest, "junction")
		await expect(manager.create("reuse", "Reuse", workspace)).rejects.toThrow(/symlink/i)
		expect(await manager.get("reuse")).toBeUndefined()
		expect(await read(existing)).toBe("dirty\n")
	})

	it("refuses to remove a previously recorded worktree on a different branch", async () => {
		const mapping = await manager.create("changed", "Changed", workspace)
		git(mapping.cwd, "switch", "-c", "other-branch")
		await write(mapping.cwd, "file.txt", "dirty\n")
		await expect(manager.remove("changed", true)).rejects.toThrow(/branch/)
		expect(await read(mapping.cwd)).toBe("dirty\n")
	})

	it("finds a cache moved under the admin directory and deinitialized", async ({ skip }) => {
		if (!git(temp, "help", "--config").includes("init.defaultSubmodulePathConfig")) skip()
		const { mapping, child } = await withSubmodule()
		const oid = git(child, "rev-parse", "HEAD")
		git(child, "branch", "alternate-only")
		const admin = git(mapping.cwd, "rev-parse", "--absolute-git-dir")
		const cache = path.join(admin, "modules", "alternate")
		await fs.mkdir(path.dirname(cache), { recursive: true })
		await fs.rename(path.join(child, ".git"), cache)
		await write(child, ".git", `gitdir: ${cache}\n`)
		git(child, "config", "core.worktree", child)
		git(mapping.cwd, "config", "core.repositoryformatversion", "1")
		git(mapping.cwd, "config", "extensions.submodulePathConfig", "true")
		git(mapping.cwd, "config", "submodule.vendor/lib.gitdir", cache)
		git(mapping.cwd, "submodule", "deinit", "-f", "--", "vendor/lib")
		expect(() => git(mapping.cwd, "config", "--get", "submodule.vendor/lib.gitdir")).toThrow()
		const { warning } = await manager.remove("safety")
		for (const item of ["alternate", "refs/heads/alternate-only", oid]) expect(warning).toContain(item)
		await manager.remove("safety", true)
		await expect(fs.access(cache)).rejects.toThrow()
	})

	it("checks the registered admin directory even when the checkout is missing", async () => {
		const { mapping, child } = await withSubmodule()
		const cache = git(mapping.cwd, "rev-parse", "--path-format=absolute", "--git-path", "modules/left/behind")
		const oid = git(child, "rev-parse", "HEAD")
		git(child, "branch", "left-behind")
		await fs.mkdir(path.dirname(cache), { recursive: true })
		await fs.rename(path.join(child, ".git"), cache)
		await fs.rm(mapping.cwd, { recursive: true })
		const { warning } = await manager.remove("safety")
		for (const item of ["left/behind", "refs/heads/left-behind", oid]) expect(warning).toContain(item)
		await manager.remove("safety", true)
		await expect(fs.access(cache)).rejects.toThrow()
	})

	it("lists a checked-out stash before removing the repository", async () => {
		const { mapping, child } = await withSubmodule()
		await write(child, "file.txt", "stashed\n")
		git(child, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "stash", "push")
		const oid = git(child, "rev-parse", "refs/stash")
		const { warning } = await manager.remove("safety")
		for (const item of ["vendor/lib", "refs/stash", oid]) expect(warning).toContain(item)
		expect(git(child, "rev-parse", "refs/stash")).toBe(oid)
		await manager.remove("safety", true)
		await expect(fs.access(mapping.cwd)).rejects.toThrow()
	})

	it("matches the full branch name and accepts a matching source branch that is ahead", async () => {
		const { child, source } = await withSubmodule()
		const oid = git(child, "rev-parse", "HEAD")
		git(child, "branch", "topic")
		git(child, "update-ref", "refs/remotes/origin/feature/topic", oid)
		expect((await manager.remove("safety")).warning).toContain("refs/heads/topic")
		git(source, "switch", "-c", "topic")
		git(source, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "Ahead")
		expect((await manager.remove("safety")).message).toContain("Worktree removed")
	})

	it("names a repository it could not inspect and how to continue", async () => {
		const mapping = await manager.create("broken-child", "Broken child", workspace)
		const child = path.join(mapping.cwd, "missing-gitdir")
		await fs.mkdir(child)
		await write(child, ".git", "gitdir: missing\n")
		const { warning } = await manager.remove("broken-child")
		for (const item of [child, "Inspect", "confirm"]) expect(warning).toContain(item)
		await manager.remove("broken-child", true)
		await expect(fs.access(mapping.cwd)).rejects.toThrow()
	})
})
