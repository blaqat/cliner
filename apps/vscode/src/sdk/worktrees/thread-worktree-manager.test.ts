import { execFileSync, spawn } from "node:child_process"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { alive, owner, storageLock } from "./storage-lock"
import { parseMmModules, ThreadWorktreeManager } from "./thread-worktree-manager"

const mmPath = "/Users/blaqat/dev/tools/scripts/mm.js"
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
	temp = await fs.mkdtemp(path.join(os.tmpdir(), "cline-thread-worktrees-"))
	workspace = path.join(temp, "workspace")
	storage = path.join(temp, "storage")
	manager = new ThreadWorktreeManager(storage)
	await repo(workspace)
	await manager.configure({ mode: "git", mmPath, nodePath: "node" })
}, 60_000)
afterEach(async () => {
	await fs.rm(temp, { recursive: true, force: true })
}, 60_000)

it("parses legacy and JSON mmrc and rejects ambiguous or escaping paths", () => {
	expect(parseMmModules("# modules\napi\nweb\n")).toEqual(["api", "web"])
	expect(parseMmModules('{"modules":["api",{"path":"packages/web","name":"UI"}]}')).toEqual(["api", "packages/web"])
	expect(() => parseMmModules('{"modules":["a/api","b/api"]}')).toThrow("share")
	expect(() => parseMmModules("../outside")).toThrow("inside")
}, 60_000)
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
	expect((await manager.takeOver("dirty")).warning).toContain("workspace has changes")
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
it("warns on removal of changes never brought in, including later changes", async () => {
	const m = await manager.create("remove", "Remove", workspace)
	await write(m.cwd, "file.txt", "first\n")
	expect((await manager.remove("remove")).warning).toContain("never brought in")
	await manager.bring("remove")
	await write(m.cwd, "file.txt", "later\n")
	expect((await manager.remove("remove")).warning).toContain("never brought in")
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
	it("auto-selects mm, creates both module worktrees and verifies real mm free", async () => {
		expect((await manager.availability(workspace)).mode).toBe("mm")
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
		expect((await manager.remove("capture")).warning).toContain("never brought in")
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
		expect((await manager.remove("staged-only")).warning).toContain("never brought in")
		for (const module of mapping.modules) await write(module.path, "file.txt", "working files\n")
		await manager.bring("staged-only")
		expect((await manager.remove("staged-only")).warning).toContain("never brought in")
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
		expect((await manager.remove("index-error")).warning).toContain("never brought in")
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
