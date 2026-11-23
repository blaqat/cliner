import { createHash, randomUUID } from "node:crypto"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import {
	NO_COMMITS,
	NOT_A_REPOSITORY,
	type ThreadModuleDiff,
	type ThreadWorktree,
	type ThreadWorktreeSettings,
	WORKTREES_OFF,
	WORKTREES_OFF_HERE,
	type WorktreeAvailability,
	type WorktreeSummary,
	worktreeFixFor,
} from "@shared/thread-worktrees"
import { Logger } from "@/shared/services/Logger"
import { createWorktree } from "@/utils/git-worktree"
import { worktreePath } from "@/utils/worktree-paths"

import { type MmWorkspace, mmDisplayPath, mmError, readMmWorkspace } from "./mm-discovery"
import {
	assertRepository,
	detachHead,
	emptyOrMissing,
	exists,
	git,
	gitlinks,
	importCommit,
	initializeSubmodules,
	ownStatus,
	type Repository,
	removalSourceRepository,
	repositories,
	run,
	submoduleRemovalWarning,
} from "./repositories"

import { alive, heartbeatMs, type Owner, owner, storageLock } from "./storage-lock"

const defaults: ThreadWorktreeSettings = { mode: "off", mmPath: "", nodePath: "node" }
const taskWorktreePrefix = "task:"
export const taskWorktreeKey = (taskGroupId: string) => taskWorktreePrefix + taskGroupId
type SessionLease = Owner & { worktreeId?: string }
interface WorkspaceRoute {
	home?: string
	useWorkspace?: boolean
}
const lineCount = (output: string) => output.split("\n").filter((line) => line.trim()).length
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`
// The workspace's own changes; its .worktrees folder (where git-mode thread worktrees live) isn't one.
const workspaceStatus = (workspacePath: string) =>
	git(workspacePath, ["status", "--porcelain", "--ignore-submodules=none", "--", ".", ":(exclude).worktrees"])

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

/** A Git worktree needs a repository with a commit to branch from; git's own errors, said plainly. */
async function assertCommitted(workspace: string) {
	try {
		await git(workspace, ["rev-parse", "--verify", "HEAD"])
	} catch (error) {
		const message = (error as Error).message
		if (/not a git repository/i.test(message)) throw new Error(NOT_A_REPOSITORY)
		if (/unknown revision|needed a single revision|ambiguous argument 'HEAD'/i.test(message)) throw new Error(NO_COMMITS)
		throw error
	}
}

async function assertMmRepositories(config: MmWorkspace) {
	const roots: string[] = []
	const folders = new Set<string>()
	const root = await worktreePath.key(config.root)
	for (const module of config.modules) {
		const canonical = await worktreePath.key(module.absolutePath)
		if (canonical !== root && !worktreePath.isInside(root, canonical))
			throw new Error("mm modules must be inside the workspace.")
		const folder = module.isolateFolder
		if (folder === ".." || path.basename(folder) !== folder) throw new Error(`Invalid mm isolate folder: ${folder}.`)
		const folderKey = await worktreePath.key(path.join(config.isolatesRoot, folder))
		if (folders.has(folderKey)) throw new Error(`mm modules share the isolate folder name ${folder}.`)
		folders.add(folderKey)
		await assertRepository(module.absolutePath)
		if (roots.includes(canonical)) throw new Error(`mm lists the same repository twice: ${module.absolutePath}.`)
		if (roots.some((other) => worktreePath.isInside(other, canonical) || worktreePath.isInside(canonical, other)))
			throw new Error(
				"mm modules include both a repository and its descendant. Select either the parent or its submodules in the mm configuration.",
			)
		roots.push(canonical)
	}
}

async function transferRepositories(modules: Repository[]) {
	const available: Repository[] = []
	const missing: Repository[] = []
	const unavailable = new Set<string>()
	const excluded = new Map<string, string[]>()
	for (const module of modules) {
		const parent = module.parent
		if (parent && unavailable.has(parent.name)) {
			unavailable.add(module.name)
			missing.push(module)
		} else if (parent && (await emptyOrMissing(module.workspacePath))) {
			const links = excluded.get(parent.name) ?? []
			links.push(parent.relative)
			excluded.set(parent.name, links)
			unavailable.add(module.name)
			missing.push(module)
		} else {
			available.push(module)
		}
	}
	return { available, missing, excluded }
}

function missingSubmoduleWarning(modules: Repository[], changed: Set<string>, next: string) {
	const names = modules.filter((module) => changed.has(module.name)).map((module) => module.name)
	if (!names.length) return undefined
	return `${names.join(", ")} ${names.length === 1 ? "has" : "have"} changes and ${names.length === 1 ? "is" : "are"} set up only in the worktree. In your workspace, run git submodule update --init --recursive from the parent repository. ${next}`
}

async function isRegisteredWorktree(workspace: string, dir: string, lockedOnly = false) {
	const registered = await git(workspace, ["worktree", "list", "--porcelain", "-z"])
	for (const entry of registered.split("\0\0")) {
		const [location, ...fields] = entry.split("\0")
		if (!location.startsWith("worktree ") || (lockedOnly && !fields.some((field) => /^locked(?: |$)/.test(field)))) continue
		if (await worktreePath.same(location.slice("worktree ".length), dir)) return true
	}
	return false
}

async function worktreeLocation(root: string, dir: string, creating = false) {
	if (!worktreePath.isInside(root, dir)) throw new Error(`Worktree path is outside its workspace: ${dir}`)
	for (let current = dir; current !== root; current = path.dirname(current)) {
		const stat = await fs.lstat(current).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error
			return undefined
		})
		if (stat?.isSymbolicLink()) throw new Error(`Worktree paths cannot pass through a symlink: ${current}`)
		if (stat && creating && current === dir)
			throw new Error(`The worktree destination already exists: ${dir}. Move it before retrying.`)
	}
}

async function ownedWorktree(module: ThreadWorktree["modules"][number], mapping: ThreadWorktree) {
	const expected = await removalSourceRepository(module.workspacePath)
	const registry = await expected(["worktree", "list", "--porcelain", "-z"])
	const entry = registry
		.split("\0\0")
		.map((record) => record.split("\0"))
		.find(([location]) => location.startsWith("worktree ") && path.normalize(location.slice(9)) === module.path)
	if (!entry || entry.includes("bare")) {
		if (await exists(module.path))
			throw new Error(
				`The path is no longer a worktree of the expected repository: ${module.path}. Inspect it before removing it.`,
			)
		return false
	}
	const attached = entry.includes(`branch refs/heads/${mapping.branch}`)
	const takenOver = mapping.takenOver && entry.includes("detached")
	if (!attached && !takenOver)
		throw new Error(`The worktree branch changed at ${module.path}. Restore ${mapping.branch} before removing it.`)
	if (await exists(module.path)) {
		const marker = path.join(module.path, ".git")
		const top = (await git(module.path, ["rev-parse", "--show-toplevel"])).trimEnd()
		if ((await fs.lstat(marker)).isSymbolicLink() || !(await worktreePath.same(top, module.path)))
			throw new Error(`The worktree repository changed at ${module.path}. Inspect it before removing it.`)
		const common = (await git(module.path, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trimEnd()
		const admin = (await git(module.path, ["rev-parse", "--absolute-git-dir"])).trimEnd()
		const registeredMarker = path.resolve(admin, (await fs.readFile(path.join(admin, "gitdir"), "utf8")).trimEnd())
		const sourceCommon = (await expected(["rev-parse", "--path-format=absolute", "--git-common-dir"])).trimEnd()
		if (registeredMarker !== marker || !(await worktreePath.same(common, sourceCommon)))
			throw new Error(`The worktree repository changed at ${module.path}. Inspect it before removing it.`)
	}
	return true
}

/** All mutations are serialized, including settings and mapping persistence. */
export class ThreadWorktreeManager {
	private queue: Promise<unknown> = Promise.resolve()
	private readonly mmWorkspaces = new Map<string, { settingsKey: string; result: Promise<MmWorkspace | undefined> }>()
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
	private async lease(id: string): Promise<SessionLease | undefined> {
		try {
			return JSON.parse(await fs.readFile(this.leaseFile(id), "utf8"))
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
			throw error
		}
	}
	async sessionBusy(id: string) {
		const lease = await this.lease(id)
		return !!lease && (await alive(lease))
	}
	async worktreeBusy(id: string) {
		if (await this.sessionBusy(id)) return true
		const dir = path.join(this.storageDir, "leases")
		const files = await fs.readdir(dir).catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return []
			throw error
		})
		for (const file of files) {
			if (!file.endsWith(".json")) continue
			const lease = await this.read<SessionLease | undefined>(path.join("leases", file), undefined)
			if (lease?.worktreeId === id && (await alive(lease))) return true
		}
		return false
	}
	async assertIdle(id: string) {
		if (!(await this.worktreeBusy(id))) return
		throw new Error(
			id.startsWith(taskWorktreePrefix)
				? "Wait for every thread using this task worktree to finish before changing it."
				: "This thread is active in another window or session. Stop it there before changing its worktree.",
		)
	}
	/** Acquired before reading the mapping and retained until the runtime is idle/stopped. */
	async acquireSessionLease(
		id: string,
		resolveWorktree?: () => Promise<{ mapping?: ThreadWorktree; taskWorktreeId?: string }>,
	): Promise<() => Promise<void>> {
		return this.exclusive(() =>
			this.withLeaseLock(id, async () => {
				if (await this.sessionBusy(id))
					throw new Error("This thread is active in another window or session. Stop it there before continuing.")
				const { mapping, taskWorktreeId } = (await resolveWorktree?.()) ?? {}
				if (mapping && mapping.threadId !== id) {
					const route = await this.workspaceRoute(id)
					if (!route.home) await this.saveWorkspaceRoute(id, { ...route, home: mapping.workspace })
				}
				const record: SessionLease = { ...owner(), worktreeId: mapping?.threadId ?? taskWorktreeId }
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

	private async writeLease(file: string, record: SessionLease) {
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
	/**
	 * Saves the fields in `change` over what's on disk now, read under the lock. Settings can be open in
	 * another window, so a save names only what the user changed and never restores what it last saw.
	 */
	async configure(change: Partial<ThreadWorktreeSettings>) {
		return this.exclusive(async () => {
			// A settings file that can't be read is replaced, as before, rather than blocking every save.
			const settings = { ...(await this.settings().catch(() => defaults)) }
			if (change.mode !== undefined) settings.mode = change.mode
			if (change.mmPath !== undefined) settings.mmPath = change.mmPath
			if (change.nodePath !== undefined) settings.nodePath = change.nodePath
			if (
				!["off", "git", "mm"].includes(settings.mode) ||
				typeof settings.mmPath !== "string" ||
				typeof settings.nodePath !== "string"
			)
				throw new Error("Invalid worktree settings")
			const home = (value: string) => value.trim().replace(/^~(?=$|[\\/])/, os.homedir())
			await this.write("settings.json", {
				mode: settings.mode,
				mmPath: home(settings.mmPath),
				nodePath: home(settings.nodePath),
			})
			this.mmWorkspaces.clear()
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
	workspaceRoute(id: string) {
		return this.read<WorkspaceRoute>(path.join("routes", this.mappingFile(id)), {})
	}
	private async saveWorkspaceRoute(id: string, route: WorkspaceRoute) {
		await this.write(path.join("routes", this.mappingFile(id)), route)
	}
	async useWorkspace(id: string) {
		await this.exclusive(() => this.saveWorkspaceRoute(id, { useWorkspace: true }))
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
	private discoverMm(workspace: string, settings: ThreadWorktreeSettings, refresh: boolean) {
		const key = path.resolve(workspace)
		const settingsKey = JSON.stringify([settings.mode, settings.nodePath, settings.mmPath])
		const cached = this.mmWorkspaces.get(key)
		if (!refresh && cached?.settingsKey === settingsKey) return cached.result
		const result = readMmWorkspace(key, settings)
		this.mmWorkspaces.set(key, { settingsKey, result })
		return result
	}

	/** For Settings: whether the folder looks like an mm workspace (a hint only) and whether mm.js is where it's set. */
	async setupHints(workspace: string): Promise<{ mmConfigFile?: string; mmFound?: boolean }> {
		const { mmPath } = await this.settings()
		let mmConfigFile: string | undefined
		for (const name of [".mm.json", ".mmrc"])
			if (await exists(path.join(workspace, name))) {
				mmConfigFile = name
				break
			}
		return { mmConfigFile, mmFound: mmPath ? await exists(path.resolve(workspace, mmPath)) : undefined }
	}

	invalidateMmWorkspace(workspace: string) {
		this.mmWorkspaces.delete(path.resolve(workspace))
	}

	async mmWorkspace(workspace: string, options: { required?: boolean; refresh?: boolean } = {}) {
		const settings = await this.settings()
		if (!settings.mmPath && settings.mode !== "mm" && !options.required) return undefined
		return this.discoverMm(workspace, settings, !!options.refresh)
	}

	private async checkAvailability(
		workspace: string,
		settings: ThreadWorktreeSettings,
		workspaceOff: boolean,
		refreshMm: boolean,
	): Promise<{ availability: WorktreeAvailability; config?: MmWorkspace }> {
		const availability: WorktreeAvailability = {
			mode: workspaceOff ? "off" : settings.mode,
			available: false,
			workspaceOff,
		}
		let config: MmWorkspace | undefined
		try {
			// Off means off: name the switch that's off, the Mode first since the workspace switch can't help
			// alone. Picking a mode in Settings turns this workspace back on too.
			if (settings.mode === "off") throw new Error(WORKTREES_OFF)
			if (workspaceOff) throw new Error(WORKTREES_OFF_HERE)
			// A set mm.js path detects mm workspaces in Git mode too; mm mode in a plain repository uses Git.
			if (settings.mmPath || settings.mode === "mm") {
				availability.mode = "mm"
				availability.mmCwd = mmDisplayPath(path.resolve(workspace))
				config = await this.discoverMm(workspace, settings, refreshMm)
				if (config) {
					try {
						await assertMmRepositories(config)
					} catch (error) {
						throw mmError(settings, (error as Error).message)
					}
					availability.modules = config.modules.map((module) => module.name)
					availability.mmCwd = mmDisplayPath(config.root)
					availability.mmConfigPath = mmDisplayPath(config.configFile)
				} else {
					// mm explicitly reported that this is not an mm workspace.
					availability.mode = "git"
					delete availability.mmCwd
				}
			}
			if (availability.mode === "git") await assertCommitted(workspace)
			availability.available = true
		} catch (error) {
			availability.reason = (error as Error).message
			availability.fix = worktreeFixFor(availability.reason)
		}
		return { availability, config }
	}

	async availability(workspace: string, workspaceOff = false, refreshMm = false): Promise<WorktreeAvailability> {
		return (await this.checkAvailability(workspace, await this.settings(), workspaceOff, refreshMm)).availability
	}
	async create(
		threadId: string,
		title: string,
		workspace: string,
		workspaceOff = false,
		task?: { id: string; beforeCreate: () => Promise<void> },
	): Promise<ThreadWorktree> {
		return this.exclusive(async () => {
			const existing = await this.get(threadId)
			if (existing) {
				await this.assertPresent(existing)
				return existing
			}
			if (task) await this.assertIdle(threadId)
			await task?.beforeCreate()
			const settings = await this.settings()
			const { availability, config } = await this.checkAvailability(workspace, settings, workspaceOff, true)
			if (!availability.available || availability.mode === "off")
				throw new Error(availability.reason + (availability.mmCwd ? `\nmm working folder is ${availability.mmCwd}.` : ""))
			// Removing the folder can keep its branch. A task can create another worktree later.
			const suffix = createHash("sha256")
				.update(task ? `${threadId}:${randomUUID()}` : threadId)
				.digest("hex")
				.slice(0, 10)
			const slug =
				title
					.toLowerCase()
					.replace(/[^a-z0-9]+/g, "-")
					.replace(/^-|-$/g, "")
					.slice(0, 44) || "thread"
			const branch = `cline/${slug}-${suffix}`
			const mode = availability.mode
			workspace = await worktreePath.key(config?.root ?? workspace)
			const cwd = config ? path.join(config.isolatesRoot, branch) : path.join(workspace, ".worktrees", `${slug}-${suffix}`)
			await worktreeLocation(workspace, cwd, true)
			const modules = config
				? config.modules.map((module) => ({
						name: module.relativePath,
						workspacePath: module.absolutePath,
						path: path.join(cwd, module.isolateFolder),
					}))
				: [{ name: "", workspacePath: (await git(workspace, ["rev-parse", "--show-toplevel"])).trim(), path: cwd }]
			const mapping: ThreadWorktree = {
				threadId,
				...(task ? { taskGroupId: task.id } : {}),
				mode,
				branch,
				workspace,
				cwd,
				createdAt: Date.now(),
				bringIns: [],
				modules: [],
			}
			for (const module of modules) {
				module.workspacePath = await worktreePath.key(module.workspacePath)
				const base = (await git(module.workspacePath, ["rev-parse", "HEAD"])).trim()
				mapping.modules.push({ ...module, base })
			}
			// Journal first: partial mm failures remain visible and removable, never orphaned.
			await this.save(mapping)
			if (mode === "mm") {
				await this.assertMutationOwner()
				try {
					const output = await run(
						settings.nodePath,
						[settings.mmPath, "isolate", branch],
						workspace,
						undefined,
						undefined,
						(stderr) => {
							for (const line of stderr.split("\n").map((line) => line.trim()))
								if (line.startsWith("warning: left ")) Logger.warn(line.slice("warning: ".length))
						},
					)
					for (const line of output.split("\n").map((line) => line.trim()))
						if (line.startsWith("left ") && line.endsWith("unset, like your workspace")) Logger.log(line)
				} catch (error) {
					throw mmError(settings, (error as Error).message.trim(), workspace)
				}
			} else {
				await this.assertMutationOwner()
				const result = await createWorktree(mapping.modules[0].workspacePath, cwd, { branch, createNewBranch: true })
				if (!result.success) throw new Error(result.message)
				await initializeSubmodules(cwd, mapping.modules[0].workspacePath)
			}
			await this.assertPresent(mapping)
			return mapping
		})
	}
	async assertPresent(mapping: ThreadWorktree) {
		const modules = await repositories(mapping)
		for (const module of modules) {
			if (!module.configured) continue
			const branch = (await git(module.path, ["branch", "--show-current"])).trim()
			if (branch !== mapping.branch && !mapping.takenOver) throw new Error(`Worktree branch changed at ${module.path}`)
			const originalCommon = path.resolve(
				module.workspacePath,
				(await git(module.workspacePath, ["rev-parse", "--git-common-dir"])).trim(),
			)
			const common = path.resolve(module.path, (await git(module.path, ["rev-parse", "--git-common-dir"])).trim())
			if (!(await worktreePath.same(originalCommon, common)))
				throw new Error(`Worktree repository changed at ${module.path}`)
		}
		return modules
	}
	private async required(id: string) {
		const mapping = await this.get(id)
		if (!mapping) throw new Error("This thread has no worktree")
		return mapping
	}
	/** Includes committed, staged, unstaged and untracked files without touching the real index. */
	async diffs(
		id: string,
		incremental = false,
		selection?: { modules: Repository[]; excluded?: Map<string, string[]> },
	): Promise<ThreadModuleDiff[]> {
		const mapping = await this.required(id)
		const modules = selection?.modules ?? (await this.assertPresent(mapping))
		const result: ThreadModuleDiff[] = []
		for (const module of modules) {
			await fs.mkdir(this.storageDir, { recursive: true })
			const index = path.join(this.storageDir, `index-${randomUUID()}`)
			const env = { GIT_INDEX_FILE: index }
			const previous = mapping.repositoryCopies?.[module.name]
			const base = incremental ? (previous?.tree ?? module.lastBroughtTree ?? module.base) : module.base
			try {
				await git(module.path, ["read-tree", "HEAD"], undefined, env)
				await git(
					module.path,
					[
						"add",
						"-A",
						"--",
						".",
						":(exclude).worktrees",
						...module.unsetPaths.map((relative) => `:(exclude,literal)${relative}`),
					],
					undefined,
					env,
				)
				const skippedLinks = selection?.excluded?.get(module.name)
				if (skippedLinks?.length) {
					const links = await gitlinks(module.path, base)
					const entries = skippedLinks.map((relative) => `160000 ${links.get(relative)}\t${relative}\0`).join("")
					await git(module.path, ["update-index", "-z", "--index-info"], entries, env)
				}
				const patch = await git(
					module.path,
					[
						"diff",
						"--cached",
						"--ignore-submodules=none",
						"--submodule=short",
						"--no-ext-diff",
						"--no-textconv",
						"--binary",
						"--full-index",
						base,
						"--",
					],
					undefined,
					env,
				)
				if (/^(?:new file mode|deleted file mode|new mode|old mode) 160000$/m.test(patch))
					throw new Error(
						"Copying added or removed submodules is not supported. Preserve this workspace before removing it.",
					)
				const names = await git(
					module.path,
					["diff", "--cached", "--ignore-submodules=none", "--name-only", "-z", base, "--"],
					undefined,
					env,
				)
				result.push({
					module: module.name,
					head: !module.configured ? (await git(module.path, ["rev-parse", "HEAD"])).trim() : undefined,
					baseHead: !module.configured ? (incremental ? (previous?.head ?? module.base) : module.base) : undefined,
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
			.update(JSON.stringify(diffs.map((d) => [d.module, d.tree, d.head])))
			.digest("hex")
	}
	private async uncopiedStaged(diffs: ThreadModuleDiff[]) {
		let count = 0
		for (const diff of diffs) {
			const staged = await git(diff.worktreePath, ["diff", "--cached", "--binary", "--ignore-submodules=none", "HEAD"])
			if (
				staged &&
				(!diff.tree ||
					(await git(diff.worktreePath, ["diff", "--cached", "--binary", "--ignore-submodules=none", diff.tree])))
			)
				count++
		}
		return count
	}
	private async repositoryState(mapping: ThreadWorktree, heads?: Map<string, string>) {
		const diffs = await this.diffs(mapping.threadId)
		const states = []
		for (const diff of diffs)
			states.push([
				diff.module,
				diff.tree,
				heads?.get(diff.module) ?? (await git(diff.worktreePath, ["rev-parse", "HEAD"])).trim(),
				await git(diff.worktreePath, ["ls-files", "--stage", "-z"]),
			])
		return createHash("sha256").update(JSON.stringify(states)).digest("hex")
	}
	private async leftoverChanges(mapping: ThreadWorktree) {
		if (!mapping.leftoverState || mapping.leftoverState !== (await this.repositoryState(mapping))) return true
		const diffs = await this.diffs(mapping.threadId)
		if (await this.uncopiedStaged(diffs)) return true
		for (const diff of diffs) if ((await ownStatus(diff.worktreePath)).trim()) return true
		return false
	}
	/** Where the thread's changes stand (see WorktreeSummary). Read-only. */
	async summary(id: string): Promise<WorktreeSummary> {
		const mapping = await this.required(id)
		let workspaceDirty = false
		const repos = await repositories(mapping)
		for (const module of repos)
			if ((await exists(path.join(module.workspacePath, ".git"))) && (await workspaceStatus(module.workspacePath)).trim())
				workspaceDirty = true
		if (mapping.takenOver) {
			// The branch lives in the workspace now; only edits made in the leftover folder since would be lost.
			const leftover = (await this.leftoverChanges(mapping))
				? Math.max(
						1,
						(await Promise.all(repos.map(async (module) => lineCount(await ownStatus(module.path))))).reduce(
							(a, b) => a + b,
							0,
						),
					)
				: 0
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
		for (const module of repos) {
			commits += Number((await git(module.path, ["rev-list", "--count", `${module.base}..HEAD`])).trim()) || 0
			uncommittedFiles += lineCount(await ownStatus(module.path))
		}
		const changedFiles = Math.max(
			full.reduce((count, diff) => count + diff.paths.length, 0),
			full.some((diff) => diff.head && diff.head !== diff.baseHead) ? 1 : 0,
		)
		const uncopiedFiles = Math.max(
			incremental.reduce((count, diff) => count + diff.paths.length, 0),
			incremental.some((diff) => diff.head && diff.head !== diff.baseHead) ? 1 : 0,
		)
		const copied =
			mapping.modules.some((module) => module.lastBroughtTree) || !!Object.keys(mapping.repositoryCopies ?? {}).length
		const kept = !!mapping.transferredDiff && this.fingerprint(full) === mapping.transferredDiff
		return {
			changedFiles,
			commits,
			uncommittedFiles,
			uncopiedFiles,
			copied,
			canUndo: mapping.bringIns.some((bring) => bring.patches.some((patch) => patch.applied && !patch.undone)),
			loseOnRemove: (await this.uncopiedStaged(full)) || (changedFiles > 0 && !kept ? uncopiedFiles || changedFiles : 0),
			workspaceDirty,
			takenOver: false,
		}
	}
	async bring(id: string) {
		return this.exclusive(async () => {
			await this.assertIdle(id)
			const mapping = await this.required(id)
			const modules = await this.assertPresent(mapping)
			const { available, missing, excluded } = await transferRepositories(modules)
			const captured = await this.diffs(id, true, { modules: available, excluded })
			const changed = (diff: ThreadModuleDiff) => !!diff.patch || (!!diff.head && diff.head !== diff.baseHead)
			const diffs = captured.filter(changed)
			const skipped = missing.length ? await this.diffs(id, true, { modules: missing }) : []
			const skippedChanges = new Set(skipped.filter(changed).map((diff) => diff.module))
			for (const module of missing)
				if (module.indexHead !== module.base || (await ownStatus(module.path)).trim()) skippedChanges.add(module.name)
			const warning = missingSubmoduleWarning(missing, skippedChanges, "Then copy the changes here again.")
			if (!diffs.length) return { message: "Nothing new to copy here", warning }
			const files = Math.max(
				diffs.reduce((count, diff) => count + diff.paths.length, 0),
				diffs.some((diff) => diff.head && diff.head !== diff.baseHead) ? 1 : 0,
			)
			for (const diff of diffs) {
				try {
					await assertRepository(diff.workspacePath)
					if (diff.head && diff.head !== diff.baseHead) {
						if ((await workspaceStatus(diff.workspacePath)).trim()) throw new Error("Submodule has local changes")
						const current = (await git(diff.workspacePath, ["rev-parse", "HEAD"])).trim()
						if (current !== diff.baseHead && current !== diff.head)
							throw new Error("Submodule HEAD differs from the last copied commit")
						await importCommit(diff.workspacePath, diff.worktreePath, diff.head)
					}
					if (diff.patch) await git(diff.workspacePath, ["apply", "--check", "--binary", "-"], diff.patch)
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
					workspacePath: diff.workspacePath,
					previousTree:
						mapping.repositoryCopies?.[diff.module]?.tree ??
						mapping.modules.find((m) => m.name === diff.module)?.lastBroughtTree,
					previousBroughtHead: mapping.repositoryCopies?.[diff.module]?.head,
					head: diff.head,
					previousHead:
						diff.head && diff.head !== diff.baseHead
							? (await git(diff.workspacePath, ["rev-parse", "HEAD"])).trim()
							: undefined,
					previousBranch: diff.head ? (await git(diff.workspacePath, ["branch", "--show-current"])).trim() : undefined,
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
				const target = patch.workspacePath ?? mapping.modules.find((m) => m.name === patch.module)?.workspacePath
				if (!target) throw new Error(`Missing saved repository: ${patch.module}`)
				await this.assertMutationOwner()
				if ((await fs.readFile(patch.file, "utf8")).trim()) await git(target, ["apply", "--binary", patch.file])
				if (patch.head && patch.previousHead && patch.head !== patch.previousHead)
					await detachHead(target, patch.head, true)
				patch.applied = true
				await this.save(mapping)
				// Store copied blobs in this repository too, so three-way undo works across independent clones.
				const index = path.join(this.storageDir, `copy-index-${randomUUID()}`)
				try {
					const env = { GIT_INDEX_FILE: index }
					await git(target, ["read-tree", "HEAD"], undefined, env)
					await git(target, ["add", "-A", "--", ".", ":(exclude).worktrees"], undefined, env)
				} finally {
					await fs.rm(index, { force: true })
				}
				mapping.repositoryCopies ??= {}
				mapping.repositoryCopies[patch.module] = { tree: patch.tree!, head: patch.head }
				const module = mapping.modules.find((m) => m.name === patch.module)
				if (module) module.lastBroughtTree = patch.tree
				await this.save(mapping)
			}
			// Clean descendants still belong to the saved snapshot. Changed descendants
			// stay out of it so removal can detect the work that remains in the isolate.
			const copied = new Map(
				[...captured, ...skipped.filter((diff) => !skippedChanges.has(diff.module))].map((diff) => [diff.module, diff]),
			)
			mapping.transferredDiff = this.fingerprint(
				modules.flatMap(({ name }) => {
					const diff = copied.get(name)
					return diff ? [diff] : []
				}),
			)
			await this.save(mapping)
			const message = `Copied ${plural(files, "file")} into your workspace`
			return { message, files, mapping, warning: warning ? `${message}. ${warning}` : undefined }
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
				const module = {
					name: patch.module,
					workspacePath: patch.workspacePath ?? mapping.modules.find((m) => m.name === patch.module)?.workspacePath,
				}
				if (!module.workspacePath) throw new Error(`Missing saved repository: ${patch.module}`)
				if (
					patch.head &&
					patch.previousHead &&
					patch.head !== patch.previousHead &&
					(await git(module.workspacePath, ["rev-parse", "HEAD"])).trim() !== patch.head
				)
					throw new Error(`Submodule HEAD changed at ${module.workspacePath}. Restore it before undoing the copy.`)
				const resetIndex =
					patch.head &&
					patch.head !== patch.previousHead &&
					!(
						await git(module.workspacePath, [
							"diff",
							"--cached",
							"--ignore-submodules=none",
							"--name-only",
							patch.head,
						])
					).trim()
				try {
					if ((await fs.readFile(patch.file, "utf8")).trim())
						await git(module.workspacePath, ["apply", "--check", "-R", patch.file])
					await this.assertMutationOwner()
					if ((await fs.readFile(patch.file, "utf8")).trim())
						await git(module.workspacePath, ["apply", "-R", patch.file])
				} catch {
					const index = path.join(this.storageDir, `undo-index-${randomUUID()}`)
					const env = { GIT_INDEX_FILE: index }
					try {
						await git(module.workspacePath, ["read-tree", "HEAD"], undefined, env)
						await git(module.workspacePath, ["add", "-A", "--", ".", ":(exclude).worktrees"], undefined, env)
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
				if (patch.head && patch.previousHead && patch.head !== patch.previousHead) {
					await detachHead(module.workspacePath, patch.previousHead, !!resetIndex)
					if (patch.previousBranch)
						await git(module.workspacePath, ["symbolic-ref", "HEAD", `refs/heads/${patch.previousBranch}`])
				}
				patch.undone = true
				if (mapping.repositoryCopies) {
					if (patch.previousTree)
						mapping.repositoryCopies[patch.module] = { tree: patch.previousTree, head: patch.previousBroughtHead }
					else delete mapping.repositoryCopies[patch.module]
				}
				const configured = mapping.modules.find((m) => m.name === patch.module)
				if (configured) configured.lastBroughtTree = patch.previousTree
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
			const modules = await this.assertPresent(mapping)
			if (mapping.takenOver) return { message: "Your workspace is on this branch now", mapping }
			const { available: repos, missing } = await transferRepositories(modules)
			for (const module of repos) {
				await assertRepository(module.workspacePath)
				if ((await workspaceStatus(module.workspacePath)).trim())
					return {
						warning: `Your workspace has uncommitted changes${mapping.modules.length > 1 ? ` in ${module.name}` : ""}. Commit or stash them, then switch.`,
					}
			}
			for (const module of mapping.modules) {
				if (await isRegisteredWorktree(module.workspacePath, module.path, true))
					return { warning: `Unlock ${module.name || "the worktree"} before switching to its branch.` }
			}
			const diffs = await this.diffs(id, false, { modules })
			const skipped = new Set<string>()
			for (const module of missing) {
				const diff = diffs.find((diff) => diff.module === module.name)!
				if (
					diff.patch ||
					diff.head !== diff.baseHead ||
					module.indexHead !== module.base ||
					(await ownStatus(module.path)).trim()
				)
					skipped.add(module.name)
			}
			const warning = missingSubmoduleWarning(
				missing,
				skipped,
				"Then open the leftover worktree (Open the leftover worktree in this menu) and bring over its remaining submodule changes.",
			)
			const transferredDiff = this.fingerprint(diffs)
			// Each step is recorded as it happens so a failure part-way undoes exactly what was done.
			const steps: {
				module: Awaited<ReturnType<typeof repositories>>[number]
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
				for (const module of repos) {
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
					const uncommitted = lineCount(await ownStatus(module.path))
					if (uncommitted) {
						await this.assertMutationOwner()
						await this.stash(module.path, [
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
					if (module.configured) await git(module.workspacePath, ["checkout", mapping.branch])
					else {
						await importCommit(module.workspacePath, module.path, step.isolateHead)
						if (module.indexHead) await importCommit(module.workspacePath, module.path, module.indexHead)
						await git(module.workspacePath, ["checkout", "--detach", step.isolateHead])
					}
					step.switched = true
					if (step.stash) {
						await this.assertMutationOwner()
						await importCommit(module.workspacePath, module.path, step.stash)
						step.applied = true
						await this.stash(module.workspacePath, ["apply", "--index", step.stash])
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
			if (!warning)
				mapping.leftoverState = await this.repositoryState(
					mapping,
					new Map(steps.map((step) => [step.module.name, step.isolateHead])),
				)
			await this.save(mapping)
			const message = carried
				? `Your workspace is on this branch now, with its ${plural(carried, "uncommitted file")}`
				: "Your workspace is on this branch now"
			return { message, files: carried, mapping, warning: warning ? `${message}. ${warning}` : undefined }
		})
	}
	/** Git stash hides staged gitlinks too when a submodule is configured with ignore=all. */
	private async stash(cwd: string, args: string[]) {
		const ignored = await git(cwd, ["config", "--null", "--name-only", "--get-regexp", "^submodule\\..*\\.ignore$"]).catch(
			() => "",
		)
		const keys = ["diff.ignoreSubmodules", ...ignored.split("\0").filter(Boolean)]
		const offset = Number(process.env.GIT_CONFIG_COUNT ?? 0)
		const env: NodeJS.ProcessEnv = { GIT_CONFIG_COUNT: String(offset + keys.length) }
		keys.forEach((key, index) => {
			env[`GIT_CONFIG_KEY_${offset + index}`] = key
			env[`GIT_CONFIG_VALUE_${offset + index}`] = "none"
		})
		return git(cwd, ["stash", ...args], undefined, env)
	}

	/** Puts a carried stash back where it came from and removes it from the stash list. */
	private async popStash(cwd: string, stash: string) {
		await this.stash(cwd, ["apply", "--index", stash])
		await this.dropStash(cwd, stash)
	}
	private async dropStash(cwd: string, stash: string) {
		const index = (await git(cwd, ["stash", "list", "--format=%H"])).split("\n").indexOf(stash)
		if (index >= 0) await git(cwd, ["stash", "drop", "--quiet", `stash@{${index}}`])
	}
	async remove(id: string, confirmed = false, beforeRemove?: () => Promise<void>) {
		return this.exclusive(async () => {
			await this.assertIdle(id)
			const mapping = await this.required(id)
			const settings = await this.settings()
			if (mapping.mode === "mm") {
				const config = await this.discoverMm(mapping.workspace, settings, true)
				if (
					!config ||
					!(await worktreePath.same(config.root, mapping.workspace)) ||
					path.join(config.isolatesRoot, mapping.branch) !== mapping.cwd ||
					config.modules.length !== mapping.modules.length ||
					!(
						await Promise.all(
							config.modules.flatMap((module, i) => [
								worktreePath.same(module.absolutePath, mapping.modules[i].workspacePath),
								path.join(config.isolatesRoot, mapping.branch, module.isolateFolder) === mapping.modules[i].path,
							]),
						)
					).every(Boolean)
				)
					throw mmError(
						settings,
						"mm configuration changed since this workspace was created. Restore its module and isolate paths before removing it.",
						mapping.workspace,
					)
			} else if (settings.mmPath || settings.mode === "mm") {
				// Refresh discovery for the menu while removing a previously created Git worktree.
				await this.discoverMm(mapping.workspace, settings, true).catch(() => {})
			}
			if (
				mapping.mode === "git" &&
				mapping.cwd !== path.join(mapping.workspace, ".worktrees", path.basename(mapping.branch))
			)
				throw new Error(`The recorded worktree path changed: ${mapping.cwd}. Inspect it before removing it.`)
			const verifyOwnership = async () => {
				await worktreeLocation(mapping.workspace, mapping.cwd)
				return Promise.all(
					mapping.modules.map(async (module) => {
						await worktreeLocation(mapping.workspace, module.path)
						return ownedWorktree(module, mapping)
					}),
				)
			}
			await verifyOwnership()
			let warning: string | undefined
			if (!confirmed && mapping.takenOver) {
				// The branch is in the workspace; only edits made in the leftover folder since would be lost.
				let leftover = true
				try {
					leftover = await this.leftoverChanges(mapping)
				} catch {
					warning = `Couldn't check changes in ${mapping.cwd}. Inspect it by hand, or confirm removal to continue.`
				}
				if (leftover) warning ??= "The leftover worktree folder has edits of its own. Remove it and discard them?"
			} else if (!confirmed) {
				let changed = true
				try {
					const diffs = await this.diffs(id)
					changed =
						diffs.some((d) => d.patch || (d.head && d.head !== d.baseHead)) &&
						this.fingerprint(diffs) !== mapping.transferredDiff
					// A working-file snapshot cannot represent a different staged version in any descendant.
					if (await this.uncopiedStaged(diffs)) changed = true
				} catch (error) {
					warning = `Couldn't check changes in ${mapping.cwd} (${(error as Error).message.trim()}). Inspect it by hand, or confirm removal to continue.`
				}
				if (changed)
					warning = ["Changes were never copied here. Remove this worktree and discard them?", warning]
						.filter(Boolean)
						.join("\n\n")
			}
			if (!confirmed) {
				warning = [await submoduleRemovalWarning(mapping), warning].filter(Boolean).join("\n\n") || undefined
			}
			if (warning) return { warning }
			await beforeRemove?.()
			const registered = await verifyOwnership()
			if (mapping.mode === "mm") {
				await this.assertMutationOwner()
				try {
					// Cline has already checked or confirmed this removal, like git mode below.
					// mm still refuses a worktree on another branch or of another repository.
					await run(
						settings.nodePath,
						[settings.mmPath, "free", mapping.branch, "--force"],
						await worktreePath.key(mapping.workspace),
					)
				} catch (error) {
					throw mmError(settings, (error as Error).message.trim(), mapping.workspace)
				}
			} else if (registered[0]) {
				await this.assertMutationOwner()
				await git(mapping.modules[0].workspacePath, ["worktree", "remove", "--force", mapping.cwd])
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
