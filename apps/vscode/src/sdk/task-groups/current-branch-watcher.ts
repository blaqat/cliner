import { promises as fs } from "node:fs"
import path from "node:path"
import chokidar, { type FSWatcher } from "chokidar"

/** Watches only HEAD, including a worktree's .git pointer, without polling. */
export class CurrentBranchWatcher {
	private root?: string
	private watcher?: FSWatcher
	private generation = 0
	private disposed = false

	constructor(private readonly onChange: () => void) {}

	async setRoot(root: string): Promise<void> {
		if (this.disposed || this.root === root) return
		this.root = root
		const generation = ++this.generation
		const previous = this.watcher
		this.watcher = undefined
		await previous?.close()
		let gitDir = path.join(root, ".git")
		try {
			const stat = await fs.stat(gitDir)
			if (stat.isFile()) {
				const pointer = (await fs.readFile(gitDir, "utf8")).trim().match(/^gitdir:\s*(.+)$/)
				if (!pointer) return
				gitDir = path.resolve(root, pointer[1])
			}
		} catch {
			// Watch a missing HEAD as well, so git init is detected.
		}
		if (generation !== this.generation) return
		this.watcher = chokidar.watch(path.join(gitDir, "HEAD"), { ignoreInitial: true })
		this.watcher.on("all", () => this.onChange())
		this.watcher.on("error", () => {})
	}

	async dispose(): Promise<void> {
		this.disposed = true
		++this.generation
		const previous = this.watcher
		this.watcher = undefined
		await previous?.close()
	}
}
