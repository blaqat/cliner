import { execFile } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { promises as fs } from "node:fs"
import path from "node:path"
import type {
	ThreadModuleDiff,
	ThreadWorktree,
	ThreadWorktreeSettings,
	WorktreeAvailability,
	WorktreeSummary,
} from "@shared/thread-worktrees"

import { createWorktree } from "@/utils/git-worktree"

import { alive, heartbeatMs, type Owner, owner, storageLock } from "./storage-lock"

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
const lineCount = (output: string) => output.split("\n").filter((line) => line.trim()).length
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`
// The workspace's own changes; its .worktrees folder (where git-mode thread worktrees live) isn't one.
const workspaceStatus = (workspacePath: string) =>
	git(workspacePath, ["status", "--porcelain", "--", ".", ":(exclude).worktrees"])

/** The folder a thread runs in: its worktree, or the workspace once the workspace took over its branch. */
export function threadRunFolder(mapping: ThreadWorktree): string {
	return mapping.takenOver ? mapping.workspace : mapping.cwd
}

/**
 * Copy changes here only applies cleanly onto the files the thread started from. When the workspace has
 * its own edits to the same lines, say which files clash and what to do, not git's raw error.
 */
export function bringClashMessage(module: string, gitError: string): string {
	const files = [
		...new Set(
			[
				...gitError.matchAll(
					/error: (?:patch failed: (.+?):\d+|(.+?): (?:patch does not apply|already exists in working directory|does not exist in index))/g,
				),
			].map((match) => (module ? `${module}/` : "") + (match[1] ?? match[2])),
		),
	]
	const which = files.length ? files.map((file) => `\`${file}\``).join(", ") : "the same files"
	return `Your workspace has its own changes to ${which} that clash with this thread's. Commit, stash or undo them in your workspace, then copy again.`
}

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
	private assertMutationOwner: () => void | Promise<void> = async () => {}
	constructor(readonly storageDir: string) {}
	async exclusive<T>(action: () => Promise<T>): Promise<T> {
		const result = this.queue.then(async () => {
			const release = await storageLock(this.storageDir)
			try {
				this.assertMutationOwner = release.assertOwned
				await release.assertOwned()
				return await action()
			} finally {
				this.assertMutationOwner = async () => {}
				await release()
			}
		})
		this.queue = result.catch(() => {})
		return result
	}
	private leaseFile(id: string) {
		return path.join(this.storageDir, "leases", `${createHash("sha256").update(id).digest("hex")}.json`)
	}
	private async lease(id: string): Promise<Owner | undefined> {
		try {
			return JSON.parse(await fs.readFile(this.leaseFile(id), "utf8"))
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
			throw error
		}
	}
	async assertIdle(id: string) {
		const lease = await this.lease(id)
		if (lease && (await alive(lease)))
			throw new Error("This thread is active in another window or session. Stop it there before changing its worktree.")
	}
	/** Acquired before reading the mapping and retained until the runtime is idle/stopped. */
	async acquireSessionLease(id: string): Promise<() => Promise<void>> {
		return this.exclusive(() =>
			this.withLeaseLock(id, async () => {
				await this.assertIdle(id)
				const record = owner()
				const file = this.leaseFile(id)
				await fs.mkdir(path.dirname(file), { recursive: true })
				await this.writeLease(file, record)
				let pending = Promise.resolve()
				const timer = setInterval(() => {
					pending = pending
						.then(() =>
							this.withLeaseLock(id, async () => {
								if ((await this.lease(id))?.token !== record.token) return
								record.timestamp = Date.now()
								await this.writeLease(file, record)
							}),
						)
						.catch(() => {})
				}, heartbeatMs)
				timer.unref()
				return async () => {
					clearInterval(timer)
					await pending
					await this.withLeaseLock(id, async () => {
						if ((await this.lease(id))?.token === record.token) await fs.rm(file, { force: true })
					})
				}
			}),
		)
	}

	private async writeLease(file: string, record: Owner) {
		const temp = `${file}.${randomUUID()}.tmp`
		await fs.writeFile(temp, JSON.stringify(record), { mode: 0o600 })
		await fs.rename(temp, file)
	}

	private async withLeaseLock<T>(id: string, action: () => Promise<T>): Promise<T> {
		const release = await storageLock(path.join(this.storageDir, "lease-locks", path.basename(this.leaseFile(id))))
		try {
			return await action()
		} finally {
			await release()
		}
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
		await this.assertMutationOwner()
		const target = path.join(this.storageDir, file)
		await fs.mkdir(path.dirname(target), { recursive: true })
		const temp = `${target}.${randomUUID()}.tmp`
		await fs.writeFile(temp, JSON.stringify(data, null, 2), { mode: 0o600 })
		await this.assertMutationOwner()
		await fs.rename(temp, target)
	}
	settings() {
		return this.read<ThreadWorktreeSettings>("settings.json", defaults)
	}
	async configure(settings: ThreadWorktreeSettings) {
		return this.exclusive(async () => {
			if (
				!["off", "git", "mm"].includes(settings.mode) ||
				typeof settings.mmPath !== "string" ||
				typeof settings.nodePath !== "string"
			)
				throw new Error("Invalid worktree settings")
			await this.write("settings.json", settings)
		})
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
	async removedWorkspace(id: string) {
		return this.read<{ workspace: string; removedAt: number } | undefined>(
			path.join("removed", this.mappingFile(id)),
			undefined,
		)
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
		return this.exclusive(async () => {
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
					mode === "git"
						? (await git(workspace, ["rev-parse", "--show-toplevel"])).trim()
						: path.join(workspace, module)
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
				await this.assertMutationOwner()
				await run(settings.nodePath, [settings.mmPath, "isolate", branch], workspace)
			} else {
				await this.assertMutationOwner()
				const result = await createWorktree(mapping.modules[0].workspacePath, cwd, { branch, createNewBranch: true })
				if (!result.success) throw new Error(result.message)
			}
			await this.assertPresent(mapping)
			return mapping
		})
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
			.update(JSON.stringify(diffs.map((d) => [d.module, d.tree])))
			.digest("hex")
	}
	/** Where the thread's changes stand (see WorktreeSummary). Read-only. */
	async summary(id: string): Promise<WorktreeSummary> {
		const mapping = await this.required(id)
		let workspaceDirty = false
		for (const module of mapping.modules) if ((await workspaceStatus(module.workspacePath)).trim()) workspaceDirty = true
		if (mapping.takenOver) {
			// The branch lives in the workspace now; only edits made in the leftover folder since would be lost.
			let leftover = 0
			for (const module of mapping.modules)
				if (await exists(path.join(module.path, ".git")))
					leftover += lineCount(await git(module.path, ["status", "--porcelain"]))
			return {
				changedFiles: 0,
				commits: 0,
				uncommittedFiles: leftover,
				uncopiedFiles: 0,
				copied: false,
				canUndo: false,
				loseOnRemove: leftover,
				workspaceDirty,
				takenOver: true,
			}
		}
		const full = await this.diffs(id)
		const incremental = await this.diffs(id, true)
		let commits = 0
		let uncommittedFiles = 0
		for (const module of mapping.modules) {
			commits += Number((await git(module.path, ["rev-list", "--count", `${module.base}..HEAD`])).trim()) || 0
			uncommittedFiles += lineCount(await git(module.path, ["status", "--porcelain"]))
		}
		const changedFiles = full.reduce((count, diff) => count + diff.paths.length, 0)
		const uncopiedFiles = incremental.reduce((count, diff) => count + diff.paths.length, 0)
		const copied = mapping.modules.some((module) => module.lastBroughtTree)
		const kept = !!mapping.transferredDiff && this.fingerprint(full) === mapping.transferredDiff
		return {
			changedFiles,
			commits,
			uncommittedFiles,
			uncopiedFiles,
			copied,
			canUndo: mapping.bringIns.some((bring) => bring.patches.some((patch) => patch.applied && !patch.undone)),
			loseOnRemove: changedFiles > 0 && !kept ? uncopiedFiles || changedFiles : 0,
			workspaceDirty,
			takenOver: false,
		}
	}
	async bring(id: string) {
		return this.exclusive(async () => {
			await this.assertIdle(id)
			const mapping = await this.required(id)
			const captured = await this.diffs(id, true)
			const diffs = captured.filter((d) => d.patch)
			if (!diffs.length) return { message: "Nothing new to copy here" }
			const files = diffs.reduce((count, diff) => count + diff.paths.length, 0)
			for (const diff of diffs) {
				try {
					await git(diff.workspacePath, ["apply", "--check", "--binary", "-"], diff.patch)
				} catch (error) {
					throw new Error(bringClashMessage(diff.module, String(error)))
				}
			}
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
				await this.assertMutationOwner()
				await git(module.workspacePath, ["apply", "--binary", patch.file])
				patch.applied = true
				module.lastBroughtTree = patch.tree
				await this.save(mapping)
			}
			mapping.transferredDiff = this.fingerprint(captured)
			await this.save(mapping)
			return { message: `Copied ${plural(files, "file")} into your workspace`, files, mapping }
		})
	}
	async undo(id: string) {
		return this.exclusive(async () => {
			await this.assertIdle(id)
			const mapping = await this.required(id)
			const bring = [...mapping.bringIns].reverse().find((b) => b.patches.some((p) => p.applied && !p.undone))
			if (!bring) return { message: "Nothing to undo" }
			const conflicts: string[] = []
			for (const patch of bring.patches.filter((p) => p.applied && !p.undone)) {
				const module = mapping.modules.find((m) => m.name === patch.module)!
				try {
					await git(module.workspacePath, ["apply", "--check", "-R", patch.file])
					await this.assertMutationOwner()
					await git(module.workspacePath, ["apply", "-R", patch.file])
				} catch {
					const index = path.join(this.storageDir, `undo-index-${randomUUID()}`)
					const env = { GIT_INDEX_FILE: index }
					try {
						await git(module.workspacePath, ["read-tree", "HEAD"], undefined, env)
						await git(module.workspacePath, ["add", "-A", "--", "."], undefined, env)
						try {
							await this.assertMutationOwner()
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
				message: conflicts.length
					? "Undid the copy. Your later edits overlap it: resolve the conflict markers in your workspace."
					: "Undid the copy",
				conflicts,
				mapping,
			}
		})
	}
	/**
	 * Switches the workspace to the thread's branch. The worktree's uncommitted edits come along (stashed
	 * there, applied here), so the thread's work never has to be committed first. Only the workspace's
	 * own uncommitted changes block it, since checking out the branch would mix them in.
	 */
	async takeOver(id: string) {
		return this.exclusive(async () => {
			await this.assertIdle(id)
			const mapping = await this.required(id)
			await this.assertPresent(mapping)
			if (mapping.takenOver) return { message: "Your workspace is on this branch now", mapping }
			for (const module of mapping.modules) {
				if ((await workspaceStatus(module.workspacePath)).trim())
					return {
						warning: `Your workspace has uncommitted changes${mapping.modules.length > 1 ? ` in ${module.name}` : ""}. Commit or stash them, then switch.`,
					}
			}
			for (const module of mapping.modules) {
				const registered = await git(module.workspacePath, ["worktree", "list", "--porcelain", "-z"])
				const canonical = await fs.realpath(module.path)
				if (
					registered
						.split("\0\0")
						.some((entry) => entry.includes(`worktree ${canonical}\0`) && entry.includes("\0locked"))
				)
					return { warning: `Unlock ${module.name || "the worktree"} before switching to its branch.` }
			}
			const transferredDiff = this.fingerprint(await this.diffs(id))
			// Each step is recorded as it happens so a failure part-way undoes exactly what was done.
			const steps: {
				module: ThreadWorktree["modules"][number]
				original: string
				isolateBranch: string
				isolateHead: string
				stash?: string
				detached?: boolean
				switched?: boolean
				applied?: boolean
			}[] = []
			let carried = 0
			try {
				for (const module of mapping.modules) {
					const original =
						(await git(module.workspacePath, ["branch", "--show-current"])).trim() ||
						(await git(module.workspacePath, ["rev-parse", "HEAD"])).trim()
					const step: (typeof steps)[number] = {
						module,
						original,
						isolateBranch: (await git(module.path, ["branch", "--show-current"])).trim(),
						isolateHead: (await git(module.path, ["rev-parse", "HEAD"])).trim(),
					}
					steps.push(step)
					const uncommitted = lineCount(await git(module.path, ["status", "--porcelain"]))
					if (uncommitted) {
						await this.assertMutationOwner()
						await git(module.path, [
							"stash",
							"push",
							"--include-untracked",
							"-m",
							`Cline: carry ${mapping.branch} into your workspace`,
						])
						step.stash = (await git(module.path, ["rev-parse", "refs/stash"])).trim()
						carried += uncommitted
					}
					// Git refuses to check out a branch attached elsewhere. Detach the isolate first.
					await this.assertMutationOwner()
					await git(module.path, ["checkout", "--detach"])
					step.detached = true
					await this.assertMutationOwner()
					await git(module.workspacePath, ["checkout", mapping.branch])
					step.switched = true
					if (step.stash) {
						await this.assertMutationOwner()
						step.applied = true
						await git(module.workspacePath, ["stash", "apply", step.stash])
					}
				}
			} catch (error) {
				const rollbackErrors: string[] = []
				for (const step of steps.reverse()) {
					try {
						await this.assertMutationOwner()
						if (step.applied) {
							// The workspace was clean before, so this only removes what the apply wrote.
							await git(step.module.workspacePath, ["reset", "--hard", "--quiet"])
							await git(step.module.workspacePath, ["clean", "-fdq", "--", ".", ":(exclude).worktrees"])
						}
						if (step.switched) await git(step.module.workspacePath, ["checkout", step.original])
						if (step.detached)
							await git(
								step.module.path,
								step.isolateBranch
									? ["checkout", step.isolateBranch]
									: ["checkout", "--detach", step.isolateHead],
							)
						if (step.stash) await this.popStash(step.module.path, step.stash)
					} catch (rollbackError) {
						rollbackErrors.push(String(rollbackError))
					}
				}
				throw new Error(
					`${String(error)}${rollbackErrors.length ? `\nCould not restore checkout: ${rollbackErrors.join("\n")}` : ""}`,
				)
			}
			// The edits are in the workspace now; their stash entries were only a carrier.
			for (const step of steps) if (step.stash) await this.dropStash(step.module.path, step.stash).catch(() => {})
			mapping.transferredDiff = transferredDiff
			mapping.takenOver = true
			await this.save(mapping)
			return {
				message: carried
					? `Your workspace is on this branch now, with its ${plural(carried, "uncommitted file")}`
					: "Your workspace is on this branch now",
				files: carried,
				mapping,
			}
		})
	}
	/** Puts a carried stash back where it came from and removes it from the stash list. */
	private async popStash(cwd: string, stash: string) {
		await git(cwd, ["stash", "apply", "--index", stash])
		await this.dropStash(cwd, stash)
	}
	private async dropStash(cwd: string, stash: string) {
		const index = (await git(cwd, ["stash", "list", "--format=%H"])).split("\n").indexOf(stash)
		if (index >= 0) await git(cwd, ["stash", "drop", "--quiet", `stash@{${index}}`])
	}
	async remove(id: string, confirmed = false) {
		return this.exclusive(async () => {
			await this.assertIdle(id)
			const mapping = await this.required(id)
			if (!confirmed && mapping.takenOver) {
				// The branch is in the workspace; only edits made in the leftover folder since would be lost.
				let leftover = true
				try {
					leftover = false
					for (const module of mapping.modules)
						if (
							(await exists(path.join(module.path, ".git"))) &&
							(await git(module.path, ["status", "--porcelain"])).trim()
						)
							leftover = true
				} catch {
					leftover = true
				}
				if (leftover) return { warning: "The leftover worktree folder has edits of its own. Remove it and discard them?" }
			} else if (!confirmed) {
				let changed = true
				try {
					const diffs = await this.diffs(id)
					changed = diffs.some((d) => d.patch) && this.fingerprint(diffs) !== mapping.transferredDiff
					// A working-file snapshot cannot represent a different staged version.
					for (const diff of diffs) {
						const staged = await git(diff.worktreePath, ["diff", "--cached", "--binary", "HEAD"])
						if (staged && (!diff.tree || (await git(diff.worktreePath, ["diff", "--cached", "--binary", diff.tree]))))
							changed = true
					}
				} catch {
					changed = true
					/* Partial isolates and unreadable indexes still need explicit removal. */
				}
				if (changed) return { warning: "Changes were never copied here. Remove this worktree and discard them?" }
			}
			if (mapping.mode === "mm") {
				const settings = await this.settings()
				await this.assertMutationOwner()
				await run(settings.nodePath, [settings.mmPath, "free", mapping.branch], mapping.workspace)
			} else {
				const registered = await git(mapping.workspace, ["worktree", "list", "--porcelain", "-z"])
				const canonical = await fs.realpath(mapping.cwd).catch(() => mapping.cwd)
				if (registered.split("\0").includes(`worktree ${canonical}`)) {
					await this.assertMutationOwner()
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
			await this.write(path.join("removed", this.mappingFile(id)), { workspace: mapping.workspace, removedAt: Date.now() })
			await fs.rm(path.join(this.storageDir, this.mappingFile(id)), { force: true })
			return {
				message: mapping.takenOver
					? "Removed the leftover worktree folder"
					: "Worktree removed. The next turn runs in your workspace. Saved copies are kept.",
			}
		})
	}
}
