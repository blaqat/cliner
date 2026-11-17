import { execFileSync } from "node:child_process"
import { promises as fs } from "node:fs"
import path from "node:path"
import { ThreadWorktreeManager } from "./thread-worktree-manager"

/** All callers supply a newly allocated temporary directory. */
export async function worktreeProject(temp: string, mode: "git" | "mm") {
	const workspace = path.join(temp, "workspace")
	const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" })
	for (const module of mode === "mm" ? ["api", "web"] : [""]) {
		const dir = path.join(workspace, module)
		await fs.mkdir(dir, { recursive: true })
		git(dir, "init", "-b", "main")
		git(dir, "config", "user.name", "Worktree test")
		git(dir, "config", "user.email", "test@example.invalid")
		await fs.writeFile(path.join(dir, "file.txt"), "base\n")
		git(dir, "add", ".")
		git(dir, "commit", "-m", "base")
	}
	if (mode === "mm") await fs.writeFile(path.join(workspace, ".mmrc"), "api\nweb\n")
	const storage = path.join(temp, "storage")
	const manager = new ThreadWorktreeManager(storage)
	await manager.configure({ mode: "git", mmPath: "/Users/blaqat/dev/tools/scripts/mm.js", nodePath: "node" })
	return { workspace, storage, manager }
}
