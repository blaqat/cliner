import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { CurrentBranchWatcher } from "./current-branch-watcher"

const mocks = vi.hoisted(() => ({ watch: vi.fn() }))
vi.mock("chokidar", () => ({ default: { watch: mocks.watch } }))

describe("current branch HEAD watcher", () => {
	let root: string
	let onChange: ReturnType<typeof vi.fn<() => void>>
	let watcher: CurrentBranchWatcher
	const listeners = new Map<string, () => void>()
	const close = vi.fn(async () => {})
	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "cline-branch-watcher-"))
		onChange = vi.fn<() => void>()
		watcher = new CurrentBranchWatcher(onChange)
		mocks.watch.mockReset().mockReturnValue({ on: vi.fn((event, callback) => listeners.set(event, callback)), close })
		close.mockClear()
		listeners.clear()
	})
	afterEach(async () => {
		await watcher.dispose()
		await fs.rm(root, { recursive: true, force: true })
	})

	it("watches only workspace HEAD, refreshes on changes, and reuses the watcher", async () => {
		await fs.mkdir(path.join(root, ".git"))
		await watcher.setRoot(root)
		await watcher.setRoot(root)
		expect(mocks.watch).toHaveBeenCalledTimes(1)
		expect(mocks.watch).toHaveBeenCalledWith(path.join(root, ".git", "HEAD"), { ignoreInitial: true })
		listeners.get("all")!()
		expect(onChange).toHaveBeenCalledTimes(1)
	})

	it("resolves worktree git pointers and closes the old watcher when roots change", async () => {
		await watcher.setRoot(root)
		const worktree = path.join(root, "worktree")
		await fs.mkdir(worktree)
		await fs.writeFile(path.join(worktree, ".git"), "gitdir: ../git/worktrees/aside\n")
		await watcher.setRoot(worktree)
		expect(mocks.watch).toHaveBeenLastCalledWith(path.join(root, "git/worktrees/aside/HEAD"), { ignoreInitial: true })
		expect(close).toHaveBeenCalledTimes(1)
		await watcher.dispose()
		expect(close).toHaveBeenCalledTimes(2)
	})
})
