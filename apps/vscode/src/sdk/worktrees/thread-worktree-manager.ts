import { execFile } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { promises as fs } from "node:fs"
import path from "node:path"
import type { ThreadModuleDiff, ThreadWorktree, ThreadWorktreeSettings, WorktreeAvailability } from "@shared/thread-worktrees"

import { createWorktree } from "@/utils/git-worktree"

const defaults: ThreadWorktreeSettings = { mode: "off", mmPath: "", nodePath: "node" }
const exists = async (file: string) =>
	fs.access(file).then(
		() => true,
		() => false,
	)

async function run(command: string, args: string[], cwd: string, input?: string, env?: NodeJS.ProcessEnv): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = execFile(
			command,
			args,
			{ cwd, env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024 },
			(error, stdout, stderr) => {
				if (error) reject(new Error(`${command} ${args[0]}: ${stderr || error.message}`))
				else resolve(stdout)
			},
		)
		child.stdin?.on("error", () => {})
		child.stdin?.end(input)
	})
}
const git = (cwd: string, args: string[], input?: string, env?: NodeJS.ProcessEnv) => run("git", args, cwd, input, env)

export function parseMmModules(raw: string): string[] {
	const text = raw.trim()
	const parsed =
		text.startsWith("{") || text.startsWith("[")
			? JSON.parse(text)
			: text
					.split("\n")
					.map((s) => s.trim())
					.filter((s) => s && !s.startsWith("#"))
	const entries = Array.isArray(parsed) ? parsed : parsed.modules
	if (!Array.isArray(entries) || !entries.length) throw new Error(".mmrc has no modules")
	const modules = entries.map((entry) => (typeof entry === "string" ? entry : entry.path))
	const names = new Set<string>()
	for (const module of modules) {
		if (typeof module !== "string" || !module || path.isAbsolute(module) || module.split(/[\\/]/).includes(".."))
			throw new Error("mm modules must be relative paths inside the workspace")
		const name = path.basename(module)
		if (names.has(name)) throw new Error(`mm modules share the isolate folder name ${name}`)
		names.add(name)
	}
	return modules
}

/** All mutations are serialized, including settings and mapping persistence. */
export class ThreadWorktreeManager {
	private queue: Promise<unknown> = Promise.resolve()
	constructor(readonly storageDir: string) {}
	async exclusive<T>(action: () => Promise<T>): Promise<T> {
		const result = this.queue.then(action)
		this.queue = result.catch(() => {})
		return result
	}
	private async read<T>(file: string, fallback: T): Promise<T> {
		try {
			return JSON.parse(await fs.readFile(path.join(this.storageDir, file), "utf8"))
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback
			throw error
		}
	}
	private async write(file: string, data: unknown) {
		const target = path.join(this.storageDir, file)
		await fs.mkdir(path.dirname(target), { recursive: true })
		const temp = `${target}.${randomUUID()}.tmp`
		await fs.writeFile(temp, JSON.stringify(data, null, 2), { mode: 0o600 })
		await fs.rename(temp, target)
	}
	settings() {
		return this.read<ThreadWorktreeSettings>("settings.json", defaults)
	}
	async configure(settings: ThreadWorktreeSettings) {
		if (
			!["off", "git", "mm"].includes(settings.mode) ||
			typeof settings.mmPath !== "string" ||
			typeof settings.nodePath !== "string"
		)
			throw new Error("Invalid worktree settings")
		await this.write("settings.json", settings)
	}
	private mappingFile(id: string) {
		return path.join("threads", `${createHash("sha256").update(id).digest("hex")}.json`)
	}
	async list(): Promise<Record<string, ThreadWorktree>> {
		const directory = path.join(this.storageDir, "threads")
		if (!(await exists(directory))) return {}
		const mappings: Record<string, ThreadWorktree> = {}
		for (const file of await fs.readdir(directory)) {
			if (!file.endsWith(".json")) continue
			const mapping = await this.read<ThreadWorktree | undefined>(path.join("threads", file), undefined)
			if (mapping) mappings[mapping.threadId] = mapping
		}
		return mappings
	}
	async get(id: string) {
		return this.read<ThreadWorktree | undefined>(this.mappingFile(id), undefined)
	}
	private async save(mapping: ThreadWorktree) {
		await this.write(this.mappingFile(mapping.threadId), mapping)
	}

	async settled(history: { id: string; isSettled?: boolean }[], doneIds: string[] = []) {
		const ids = new Set([...history.filter((item) => item.isSettled).map((item) => item.id), ...doneIds])
		return Object.values(await this.list()).filter((item) => ids.has(item.threadId))
	}
	async availability(workspace: string, workspaceOff = false): Promise<WorktreeAvailability> {
		const settings = await this.settings()
		const hasMmrc = await exists(path.join(workspace, ".mmrc"))
		const mode = workspaceOff ? "off" : hasMmrc ? "mm" : settings.mode === "mm" ? "git" : settings.mode
		const result: WorktreeAvailability = { mode, available: false, workspaceOff, hasMmrc }
		try {
			if (mode === "off") throw new Error("Worktrees are off for this workspace")
			if (mode === "mm") {
				if (!settings.mmPath) throw new Error("Set the path to mm.js in Worktrees settings")
				await fs.access(settings.mmPath)
				await run(settings.nodePath, ["--version"], workspace)
				const modules = parseMmModules(await fs.readFile(path.join(workspace, ".mmrc"), "utf8"))
				for (const module of modules) await git(path.join(workspace, module), ["rev-parse", "--verify", "HEAD"])
			} else await git(workspace, ["rev-parse", "--verify", "HEAD"])
			result.available = true
		} catch (error) {
			result.reason = (error as Error).message
		}
		return result
	}
	async create(threadId: string, title: string, workspace: string, workspaceOff = false): Promise<ThreadWorktree> {
		const existing = await this.get(threadId)
		if (existing) {
			await this.assertPresent(existing)
			return existing
		}
		const availability = await this.availability(workspace, workspaceOff)
		if (!availability.available || availability.mode === "off") throw new Error(availability.reason)
		const suffix = createHash("sha256").update(threadId).digest("hex").slice(0, 10)
		const slug =
			title
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, "-")
				.replace(/^-|-$/g, "")
				.slice(0, 44) || "thread"
		const branch = `cline/${slug}-${suffix}`
		const mode = availability.mode
		const cwd =
			mode === "mm" ? path.join(workspace, "isolates", branch) : path.join(workspace, ".worktrees", `${slug}-${suffix}`)
		const modules = mode === "mm" ? parseMmModules(await fs.readFile(path.join(workspace, ".mmrc"), "utf8")) : [""]
		const mapping: ThreadWorktree = {
			threadId,
			mode,
			branch,
			workspace,
			cwd,
			createdAt: Date.now(),
			bringIns: [],
			modules: [],
		}
		for (const module of modules) {
			const workspacePath =
				mode === "git" ? (await git(workspace, ["rev-parse", "--show-toplevel"])).trim() : path.join(workspace, module)
			const base = (await git(workspacePath, ["rev-parse", "HEAD"])).trim()
			mapping.modules.push({
				name: module,
				workspacePath,
				path: mode === "mm" ? path.join(cwd, path.basename(module)) : cwd,
				base,
			})
		}
		// Journal first: partial mm failures remain visible and removable, never orphaned.
		await this.save(mapping)
		if (mode === "mm") {
			const settings = await this.settings()
			await run(settings.nodePath, [settings.mmPath, "isolate", branch], workspace)
		} else {
			const result = await createWorktree(mapping.modules[0].workspacePath, cwd, { branch, createNewBranch: true })
			if (!result.success) throw new Error(result.message)
		}
		await this.assertPresent(mapping)
		return mapping
	}
	async assertPresent(mapping: ThreadWorktree) {
		for (const module of mapping.modules) {
			if (!(await exists(path.join(module.path, ".git"))))
				throw new Error(`Worktree missing: ${module.path}. Remove it or restore it before resuming.`)
			const branch = (await git(module.path, ["branch", "--show-current"])).trim()
			if (branch !== mapping.branch && !mapping.takenOver) throw new Error(`Worktree branch changed at ${module.path}`)
		}
	}
	private async required(id: string) {
		const mapping = await this.get(id)
		if (!mapping) throw new Error("This thread has no worktree")
		return mapping
	}
	/** Includes committed, staged, unstaged and untracked files without touching the real index. */
	async diffs(id: string, incremental = false): Promise<ThreadModuleDiff[]> {
		const mapping = await this.required(id)
		await this.assertPresent(mapping)
		const result: ThreadModuleDiff[] = []
		for (const module of mapping.modules) {
			await fs.mkdir(this.storageDir, { recursive: true })
			const index = path.join(this.storageDir, `index-${randomUUID()}`)
			const env = { GIT_INDEX_FILE: index }
			const base = incremental ? (module.lastBroughtTree ?? module.base) : module.base
			try {
				await git(module.path, ["read-tree", "HEAD"], undefined, env)
				await git(module.path, ["add", "-A", "--", "."], undefined, env)
				const patch = await git(module.path, ["diff", "--cached", "--binary", "--full-index", base, "--"], undefined, env)
				const names = await git(module.path, ["diff", "--cached", "--name-only", "-z", base, "--"], undefined, env)
				result.push({
					module: module.name,
					workspacePath: module.workspacePath,
					worktreePath: module.path,
					base,
					tree: (await git(module.path, ["write-tree"], undefined, env)).trim(),
					patch,
					paths: names
						.split("\0")
						.filter(Boolean)
						.map((name) => (module.name ? `${module.name}/${name}` : name)),
				})
			} finally {
				await fs.rm(index, { force: true })
			}
		}
		return result
	}
	private fingerprint(diffs: ThreadModuleDiff[]) {
		return createHash("sha256")
			.update(JSON.stringify(diffs.map((d) => [d.module, d.patch])))
			.digest("hex")
	}
	async bring(id: string) {
		const mapping = await this.required(id)
		const diffs = (await this.diffs(id, true)).filter((d) => d.patch)
		if (!diffs.length) return { message: "No changes to bring here" }
		for (const diff of diffs) await git(diff.workspacePath, ["apply", "--check", "--binary", "-"], diff.patch)
		const bring = { id: randomUUID(), patches: [] as ThreadWorktree["bringIns"][number]["patches"] }
		const folder = path.join(this.storageDir, "patches", bring.id)
		await fs.mkdir(folder, { recursive: true })
		for (const [i, diff] of diffs.entries()) {
			const file = path.join(folder, `${i}.patch`)
			await fs.writeFile(file, diff.patch, { mode: 0o600 })
			bring.patches.push({
				module: diff.module,
				file,
				applied: false,
				previousTree: mapping.modules.find((m) => m.name === diff.module)?.lastBroughtTree,
				tree: diff.tree,
			})
		}
		await fs.writeFile(
			path.join(folder, "manifest.json"),
			JSON.stringify(
				{ threadId: id, branch: mapping.branch, workspace: mapping.workspace, patches: bring.patches },
				null,
				2,
			),
			{ mode: 0o600 },
		)
		mapping.bringIns.push(bring)
		await this.save(mapping)
		for (const patch of bring.patches) {
			const module = mapping.modules.find((m) => m.name === patch.module)!
			await git(module.workspacePath, ["apply", "--binary", patch.file])
			patch.applied = true
			module.lastBroughtTree = patch.tree
			await this.save(mapping)
		}
		mapping.transferredDiff = this.fingerprint(await this.diffs(id))
		await this.save(mapping)
		return { message: "Brought changes into your workspace. Patches saved.", mapping }
	}
	async undo(id: string) {
		const mapping = await this.required(id)
		const bring = [...mapping.bringIns].reverse().find((b) => b.patches.some((p) => p.applied && !p.undone))
		if (!bring) return { message: "No bring-in to undo" }
		const conflicts: string[] = []
		for (const patch of bring.patches.filter((p) => p.applied && !p.undone)) {
			const module = mapping.modules.find((m) => m.name === patch.module)!
			try {
				await git(module.workspacePath, ["apply", "--check", "-R", patch.file])
				await git(module.workspacePath, ["apply", "-R", patch.file])
			} catch {
				const index = path.join(this.storageDir, `undo-index-${randomUUID()}`)
				const env = { GIT_INDEX_FILE: index }
				try {
					await git(module.workspacePath, ["read-tree", "HEAD"], undefined, env)
					await git(module.workspacePath, ["add", "-A", "--", "."], undefined, env)
					try {
						await git(module.workspacePath, ["apply", "-3", "-R", "--index", patch.file], undefined, env)
					} catch (error) {
						const unmerged = (
							await git(module.workspacePath, ["diff", "--name-only", "--diff-filter=U", "-z"], undefined, env)
						)
							.split("\0")
							.filter(Boolean)
						if (!unmerged.length) throw error
						conflicts.push(...unmerged.map((file) => (module.name ? `${module.name}/${file}` : file)))
					}
				} finally {
					await fs.rm(index, { force: true })
				}
			}
			patch.undone = true
			module.lastBroughtTree = patch.previousTree
			await this.save(mapping)
		}
		mapping.transferredDiff = undefined
		await this.save(mapping)
		return {
			message: conflicts.length ? "Resolve the conflict markers in your workspace before continuing." : "Bring-in undone",
			conflicts,
			mapping,
		}
	}
	async takeOver(id: string) {
		const mapping = await this.required(id)
		await this.assertPresent(mapping)
		for (const module of mapping.modules) {
			if ((await git(module.workspacePath, ["status", "--porcelain", "--", ".", ":(exclude).worktrees"])).trim())
				return {
					warning: `Your workspace has changes in ${module.name || "this repository"}. Commit or shelve them before taking over.`,
				}
			if ((await git(module.path, ["status", "--porcelain"])).trim())
				return { warning: "Commit or bring in the worktree's changes before taking over its branch." }
		}
		for (const module of mapping.modules) {
			const registered = await git(module.workspacePath, ["worktree", "list", "--porcelain", "-z"])
			const canonical = await fs.realpath(module.path)
			if (registered.split("\0\0").some((entry) => entry.includes(`worktree ${canonical}\0`) && entry.includes("\0locked")))
				return { warning: `Unlock ${module.name || "the worktree"} before taking over.` }
		}
		const transferredDiff = this.fingerprint(await this.diffs(id))
		// Git refuses checkout of a branch attached elsewhere. Detach the isolate first.
		const moved: {
			module: ThreadWorktree["modules"][number]
			original: string
			isolateBranch: string
			isolateHead: string
		}[] = []
		try {
			for (const module of mapping.modules) {
				const original =
					(await git(module.workspacePath, ["branch", "--show-current"])).trim() ||
					(await git(module.workspacePath, ["rev-parse", "HEAD"])).trim()
				const isolateBranch = (await git(module.path, ["branch", "--show-current"])).trim()
				const isolateHead = (await git(module.path, ["rev-parse", "HEAD"])).trim()
				await git(module.path, ["checkout", "--detach"])
				moved.push({ module, original, isolateBranch, isolateHead })
				await git(module.workspacePath, ["checkout", mapping.branch])
			}
		} catch (error) {
			const rollbackErrors: string[] = []
			for (const entry of moved.reverse()) {
				try {
					await git(entry.module.workspacePath, ["checkout", entry.original])
					await git(
						entry.module.path,
						entry.isolateBranch ? ["checkout", entry.isolateBranch] : ["checkout", "--detach", entry.isolateHead],
					)
				} catch (rollbackError) {
					rollbackErrors.push(String(rollbackError))
				}
			}
			throw new Error(
				`${String(error)}${rollbackErrors.length ? `\nCould not restore checkout: ${rollbackErrors.join("\n")}` : ""}`,
			)
		}
		mapping.transferredDiff = transferredDiff
		mapping.takenOver = true
		await this.save(mapping)
		return { message: "Worktree branch checked out in your workspace", mapping }
	}
	async remove(id: string, confirmed = false) {
		const mapping = await this.required(id)
		if (!confirmed) {
			let changed = true
			try {
				const diffs = await this.diffs(id)
				changed = diffs.some((d) => d.patch) && this.fingerprint(diffs) !== mapping.transferredDiff
			} catch {
				/* Partial isolates still need explicit removal. */
			}
			if (changed) return { warning: "Changes were never brought in. Remove this worktree and discard those changes?" }
		}
		if (mapping.mode === "mm") {
			const settings = await this.settings()
			await run(settings.nodePath, [settings.mmPath, "free", mapping.branch], mapping.workspace)
		} else {
			const registered = await git(mapping.workspace, ["worktree", "list", "--porcelain", "-z"])
			const canonical = await fs.realpath(mapping.cwd).catch(() => mapping.cwd)
			if (registered.split("\0").includes(`worktree ${canonical}`)) {
				await git(mapping.workspace, [
					"worktree",
					"remove",
					...(confirmed || mapping.transferredDiff ? ["--force"] : []),
					mapping.cwd,
				])
			} else if (await exists(mapping.cwd))
				throw new Error(
					"The recorded path is no longer a registered worktree. Inspect it before removing the thread mapping.",
				)
		}
		for (const module of mapping.modules)
			if (await exists(path.join(module.path, ".git"))) throw new Error(`Worktree was not removed: ${module.path}`)
		await fs.rm(path.join(this.storageDir, this.mappingFile(id)), { force: true })
		return { message: "Worktree removed. Saved bring-in patches are kept." }
	}
}
