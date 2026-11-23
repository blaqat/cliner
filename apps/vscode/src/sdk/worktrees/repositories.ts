import { execFile } from "node:child_process"
import { promises as fs } from "node:fs"
import path from "node:path"
import type { ThreadWorktree, WorktreeModule } from "@shared/thread-worktrees"
import { Logger } from "@/shared/services/Logger"
import { worktreePath } from "@/utils/worktree-paths"

export async function run(
	command: string,
	args: string[],
	cwd: string,
	input?: string,
	env?: NodeJS.ProcessEnv,
	onStderr?: (stderr: string) => void,
): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = execFile(
			command,
			args,
			{ cwd, env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024 },
			(error, stdout, stderr) => {
				if (error) reject(new Error(`${command} ${args[0]}: ${stderr || error.message}`, { cause: error }))
				else {
					try {
						onStderr?.(stderr)
						resolve(stdout)
					} catch (callbackError) {
						reject(callbackError)
					}
				}
			},
		)
		child.stdin?.on("error", () => {})
		child.stdin?.end(input)
	})
}
export const git = async (
	cwd: string,
	args: string[],
	input?: string,
	env?: NodeJS.ProcessEnv,
	onStderr?: (stderr: string) => void,
) =>
	run(
		"git",
		["-c", "submodule.recurse=false", ...args],
		await worktreePath.key(cwd),
		input,
		{
			GIT_OPTIONAL_LOCKS: "0",
			...env,
		},
		onStderr,
	)
export const exists = (file: string) =>
	fs.access(file).then(
		() => true,
		() => false,
	)

export async function assertRepository(dir: string) {
	if (
		!(await exists(path.join(dir, ".git"))) ||
		!(await worktreePath.same((await git(dir, ["rev-parse", "--show-toplevel"])).trim(), dir))
	)
		throw new Error(`Worktree missing or not a repository root: ${dir}. Restore it before resuming.`)
	await git(dir, ["rev-parse", "--verify", "HEAD"])
}

export async function gitlinks(dir: string, tree: string) {
	return parseGitlinks(await git(dir, ["ls-tree", "-rz", tree]), 2)
}

function parseGitlinks(output: string, oidField: number): Map<string, string> {
	const links = new Map<string, string>()
	for (const entry of output.split("\0")) {
		if (!entry.startsWith("160000 ")) continue
		const tab = entry.indexOf("\t")
		const relative = entry.slice(tab + 1)
		if (!links.has(relative)) links.set(relative, entry.slice(0, tab).split(" ")[oidField])
	}
	return links
}

/** Compare gitlink entries without relying on Git's submodule-ignore settings. */
export async function submoduleLinks(
	dir: string,
	beforeRef: string | undefined,
	afterRef: string | undefined,
	includeIndex: boolean,
) {
	const [before, after, index] = await Promise.all([
		beforeRef ? gitlinks(dir, beforeRef) : new Map<string, string>(),
		afterRef ? gitlinks(dir, afterRef) : new Map<string, string>(),
		includeIndex
			? git(dir, ["ls-files", "--stage", "-z"]).then((output) => parseGitlinks(output, 1))
			: new Map<string, string>(),
	])
	return [...new Set([...before.keys(), ...after.keys(), ...index.keys()])].map((relative) => ({
		relative,
		before: before.get(relative),
		after: after.get(relative),
		index: index.get(relative),
	}))
}

export async function submodulePath(dir: string, relative: string): Promise<string> {
	const child = path.resolve(dir, relative)
	if (!worktreePath.isInside(dir, child) || !(await worktreePath.inside(dir, child)))
		throw new Error(`Submodule outside its repository: ${relative}`)
	return worktreePath.key(child)
}

export async function emptyOrMissing(dir: string) {
	try {
		return (await fs.lstat(dir)).isDirectory() && (await fs.readdir(dir)).length === 0
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return true
		throw error
	}
}

export interface Repository extends WorktreeModule {
	configured: boolean
	/** Commit the parent index names, which can differ from the checked-out child HEAD. */
	indexHead?: string
	parent?: { name: string; relative: string }
	unsetPaths: string[]
}

/** Every descendant has its own object database and index, and may have detached HEAD. */
export async function repositories(mapping: ThreadWorktree): Promise<Repository[]> {
	const result: Repository[] = []
	async function visit(module: WorktreeModule, parent?: Repository["parent"], indexHead?: string) {
		await assertRepository(module.path)
		module = { ...module, path: await worktreePath.key(module.path) }
		const unsetPaths: string[] = []
		result.push({ ...module, configured: !parent, parent, indexHead, unsetPaths })
		for (const { relative, before, after, index } of await submoduleLinks(module.path, module.base, "HEAD", true)) {
			if (!before || !after)
				throw new Error(
					`Submodule added or removed at ${relative}. Commit or preserve this workspace before removing it; copying submodule layout changes is not supported.`,
				)
			const name = [module.name, relative].filter(Boolean).join("/")
			const child = await submodulePath(module.path, relative)
			if (before === after && after === index && (await emptyOrMissing(child))) {
				unsetPaths.push(relative)
				continue
			}
			await visit(
				{
					name,
					path: child,
					workspacePath: await submodulePath(module.workspacePath, relative),
					base: before,
				},
				{ name: module.name, relative },
				index,
			)
		}
	}
	for (const module of mapping.modules) await visit(module)
	return result
}

const submodulePathKeys = "^submodule\\..*\\.path$"

async function submoduleNames(repositoryGit: (args: string[]) => Promise<string>) {
	const entries = await repositoryGit(["config", "--blob", "HEAD:.gitmodules", "--null", "--get-regexp", submodulePathKeys])
	return new Map(
		entries
			.split("\0")
			.filter(Boolean)
			.map((entry) => {
				const newline = entry.indexOf("\n")
				return [entry.slice(newline + 1), entry.slice("submodule.".length, newline - ".path".length)]
			}),
	)
}

function submoduleName(names: Map<string, string>, relative: string) {
	const name = names.get(relative)
	if (!name) throw new Error(`Submodule path missing from .gitmodules: ${relative}`)
	return name
}

async function submoduleCache(
	repositoryGit: (args: string[]) => Promise<string>,
	worktree: string,
	name: string,
): Promise<string> {
	const configured = await repositoryGit(["config", "--bool", "--get", "extensions.submodulePathConfig"]).catch(() => "")
	if (configured.trim() === "true") {
		const location = await repositoryGit(["config", "--get", `submodule.${name}.gitdir`]).catch(() => "")
		if (location.trimEnd()) return worktreePath.key(path.resolve(worktree, location.trimEnd()))
	}
	const modules = (await repositoryGit(["rev-parse", "--path-format=absolute", "--git-path", "modules"])).trimEnd()
	return submodulePath(modules, name)
}

const cachedGit = (cwd: string, gitDir: string, args: string[]) =>
	git(cwd, [`--git-dir=${gitDir}`, `--work-tree=${cwd}`, ...args], undefined, { GIT_NO_LAZY_FETCH: "1" })

const inspectionEnv = { GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1" }
const perWorktreeRef = /^refs\/(bisect|worktree|rewritten)\//

async function removalStat(file: string) {
	try {
		return await fs.lstat(file)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
		throw error
	}
}

type RemovalGit = (args: string[], input?: string) => Promise<string>

/** A configured mm module can be a submodule deinitialized in the source checkout. */
export async function removalSourceRepository(dir: string): Promise<RemovalGit> {
	if (await removalStat(path.join(dir, ".git"))) {
		await assertRepository(dir)
		return (args) => git(dir, args)
	}
	for (let parent = path.dirname(dir); parent !== path.dirname(parent); parent = path.dirname(parent)) {
		if (!(await removalStat(path.join(parent, ".git")))) continue
		const read = (args: string[]) => git(parent, args)
		const names = await submoduleNames(read).catch(() => new Map<string, string>())
		const name = names.get(path.relative(parent, dir).split(path.sep).join("/"))
		if (name) return removalGit(parent, await submoduleCache(read, parent, name))
		break
	}
	throw new Error(`Couldn't identify the source repository at ${dir}. Restore it before removing the worktree.`)
}

/** The source registry, never the checkout, names the admin directory Git will delete. */
async function removalAdmin(source: string, checkout: string) {
	const read = await removalSourceRepository(source)
	const registry = (await read(["rev-parse", "--path-format=absolute", "--git-path", "worktrees"])).trimEnd()
	const marker = path.join(checkout, ".git")
	let registered: string | undefined
	for (const entry of (await removalStat(registry)) ? await fs.readdir(registry, { withFileTypes: true }) : []) {
		if (!entry.isDirectory()) continue
		const admin = path.join(registry, entry.name)
		const pointer = path.join(admin, "gitdir")
		if (!(await removalStat(pointer))) continue
		if (await worktreePath.same(path.resolve(admin, (await fs.readFile(pointer, "utf8")).trimEnd()), marker)) {
			registered = await worktreePath.key(admin)
			break
		}
	}
	if (
		(await removalStat(checkout)) &&
		(!registered ||
			(await worktreePath.key((await git(checkout, ["rev-parse", "--absolute-git-dir"])).trimEnd())) !== registered)
	)
		throw new Error(`The worktree repository changed at ${checkout}. Inspect it before removing it.`)
	return registered
}

function removalGit(cwd: string, dir: string): RemovalGit {
	return (args, input) =>
		git(cwd, [`--git-dir=${dir}`, `--work-tree=${cwd}`, ...args], input, inspectionEnv, (stderr) => {
			if (stderr.trim()) throw new Error(stderr.trim())
		})
}

async function removalRefs(read: RemovalGit) {
	const rows = await read(["for-each-ref", "--format=%(refname) %(objectname) %(objecttype) %(symref)"])
	return rows
		.split("\n")
		.filter(Boolean)
		.map((row) => {
			const [name, oid, type, symbolic] = row.trimEnd().split(" ")
			return { name, oid, type, symbolic }
		})
}

async function trackingRefs(read: RemovalGit, refs: Awaited<ReturnType<typeof removalRefs>>) {
	const tracked = new Map<string, string>()
	if (!refs.some(({ name }) => name.startsWith("refs/remotes/"))) return tracked
	const prefixes = (await read(["remote"]))
		.split("\n")
		.filter(Boolean)
		.map((remote) => `refs/remotes/${remote}/`)
		.sort((a, b) => b.length - a.length)
	for (const { name, symbolic } of refs) {
		const prefix = prefixes.find((candidate) => name.startsWith(candidate))
		if (prefix) tracked.set(name, symbolic ? "" : name.slice(prefix.length))
	}
	return tracked
}

async function detachedHead(dir: string) {
	const head = (await fs.readFile(path.join(dir, "HEAD"), "utf8")).trim()
	if (head.startsWith("ref: ")) return undefined
	if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head)) throw new Error("Invalid Git HEAD")
	return head
}

async function contains(read: RemovalGit, oid: string, tip: string, type = "commit") {
	if (oid === tip) return true
	if (type !== "commit") return false
	try {
		await read(["merge-base", "--is-ancestor", oid, tip])
		return true
	} catch (error) {
		if (((error as Error).cause as { code?: number } | undefined)?.code === 1) return false
		throw error
	}
}

/** Discover repositories in the paths Git will delete, even if the parent forgot their gitlinks. */
export async function submoduleRemovalWarning(mapping: ThreadWorktree): Promise<string | undefined> {
	const lost: string[] = []
	const unchecked: string[] = []
	const recordError = (file: string, error: unknown) => unchecked.push(`${file} (${(error as Error).message.trim()})`)
	const modules: { module: WorktreeModule; admin: string }[] = []
	for (const module of mapping.modules) {
		try {
			const admin = await removalAdmin(module.workspacePath, module.path)
			if (admin) modules.push({ module, admin })
		} catch (error) {
			recordError(module.path, error)
		}
	}
	const deletionRoots = modules.flatMap(({ module, admin }) => [module.path, admin])
	const insideDeletion = (dir: string) => deletionRoots.some((root) => dir === root || worktreePath.isInside(root, dir))
	for (const { module, admin } of modules) {
		const checkout = module.path
		const visited = new Set<string>()
		const repositories = new Map<string, { sourceCheckout?: string; sourceCache?: string }>()
		try {
			const cwd = (await removalStat(checkout)) ? checkout : mapping.workspace
			const sourceRead = await removalSourceRepository(module.workspacePath)
			const sourceAdmin = (await sourceRead(["rev-parse", "--absolute-git-dir"])).trimEnd()
			const insideModule = (dir: string) =>
				dir === admin || dir === checkout || worktreePath.isInside(admin, dir) || worktreePath.isInside(checkout, dir)
			const resolveMarker = async (marker: string) =>
				worktreePath.key((await git(cwd, ["rev-parse", "--resolve-git-dir", marker])).trimEnd())
			const label = (dir: string) => {
				const root = worktreePath.isInside(admin, dir) ? admin : checkout
				const relative = path
					.relative(root, dir)
					.split(path.sep)
					.join("/")
					.replace(/\/\.git$/, "")
				return [module.name, dir === admin ? "" : relative].filter(Boolean).join("/") || "Worktree"
			}

			// A source submodule can be deinitialized at any depth. Its parent
			// cache still records the submodule name and Git directory.
			const sourceDirectories = new Map<string, string | undefined>([[module.workspacePath, sourceAdmin]])
			async function sourceDirectory(checkout: string): Promise<string | undefined> {
				if (sourceDirectories.has(checkout)) return sourceDirectories.get(checkout)
				let dir: string | undefined
				const marker = path.join(checkout, ".git")
				if (await removalStat(marker)) {
					dir = await resolveMarker(marker)
				} else {
					for (
						let child = checkout, parent = path.dirname(child);
						parent !== child;
						child = parent, parent = path.dirname(child)
					) {
						const parentDir = await sourceDirectory(parent)
						if (parentDir) {
							const read = removalGit(cwd, parentDir)
							const names = await submoduleNames(read).catch(() => new Map<string, string>())
							const name = names.get(path.relative(parent, checkout).split(path.sep).join("/"))
							if (name) {
								const cache = await submoduleCache(read, parent, name)
								if ((await removalStat(cache))?.isDirectory()) dir = await worktreePath.key(cache)
							}
							break
						}
					}
				}
				sourceDirectories.set(checkout, dir)
				return dir
			}

			async function inspect(dir: string, sourceCheckout: string | undefined, sourceCache?: string) {
				try {
					const read = removalGit(cwd, dir)
					const common = await worktreePath.key(
						(await read(["rev-parse", "--path-format=absolute", "--git-common-dir"])).trimEnd(),
					)
					const refs = await removalRefs(read)
					const head = await detachedHead(dir)
					const deleted = (name: string) => insideDeletion(common) || perWorktreeRef.test(name)
					const candidates = refs.filter(({ name, symbolic }) => !symbolic && deleted(name))
					if (!candidates.length && !head) return
					const remotes = candidates.length ? await trackingRefs(read, refs) : new Map()
					const sourceDir =
						(sourceCheckout && (await sourceDirectory(sourceCheckout))) ||
						(sourceCache && (await removalStat(sourceCache))?.isDirectory()
							? await worktreePath.key(sourceCache)
							: undefined)
					const sourceRead = sourceDir && !insideDeletion(sourceDir) ? removalGit(cwd, sourceDir) : undefined
					const sourceCommon =
						sourceRead &&
						(await worktreePath.key(
							(await sourceRead(["rev-parse", "--path-format=absolute", "--git-common-dir"])).trimEnd(),
						))
					const source = sourceRead && sourceCommon && !insideDeletion(sourceCommon) ? sourceRead : undefined
					const sourceRefs = source && (candidates.length || head) ? await removalRefs(source) : []
					const sourceRemotes = source && candidates.length ? await trackingRefs(source, sourceRefs) : new Map()
					const sourceHead = source && sourceDir && head ? await detachedHead(sourceDir) : undefined
					const sourceHas = async (oid: string, targets: typeof refs) => {
						if (!source || !targets.length) return false
						if (targets.some((target) => target.oid === oid)) return true
						// Test object presence without confusing a missing object with an inspection failure.
						if ((await source(["cat-file", "--batch-check"], `${oid}\n`)).trimEnd().endsWith(" missing")) return false
						for (const target of targets) if (await contains(source, oid, target.oid, target.type)) return true
						return false
					}
					for (const { name, oid, type } of candidates) {
						const branch = name.startsWith("refs/heads/") ? name.slice("refs/heads/".length) : remotes.get(name)
						const targets = sourceRefs.filter(
							(ref) =>
								ref.name === name ||
								(branch && (ref.name === `refs/heads/${branch}` || sourceRemotes.get(ref.name) === branch)),
						)
						const preserved =
							name !== "refs/stash" &&
							(type === "commit" ? await sourceHas(oid, targets) : targets.some((ref) => ref.oid === oid))
						if (!preserved) lost.push(`${label(dir)} · ${name} · ${oid}`)
					}
					if (head) {
						let preserved = await sourceHas(
							head,
							sourceHead
								? [...sourceRefs, { name: "HEAD", oid: sourceHead, type: "commit", symbolic: "" }]
								: sourceRefs,
						)
						for (const ref of refs) {
							if (preserved) break
							if (!deleted(ref.name)) preserved = await contains(read, head, ref.oid, ref.type)
						}
						if (!preserved) lost.push(`${label(dir)} · detached HEAD · ${head}`)
					}
				} catch (error) {
					recordError(dir, error)
				}
			}

			async function walk(dir: string, sourceCheckout?: string, sourceCache?: string, inAdmin = false) {
				if (visited.has(dir)) return
				visited.add(dir)
				try {
					const stat = await removalStat(dir)
					if (!stat || stat.isSymbolicLink()) return
					if (!stat.isDirectory()) throw new Error("Expected a directory")
					const entries = await fs.readdir(dir, { withFileTypes: true })
					const names = new Set(entries.map((entry) => entry.name))
					const gitDirectory =
						repositories.has(dir) ||
						(dir !== checkout &&
							((names.has("HEAD") &&
								(names.has("commondir") || names.has("objects") || (inAdmin && names.has("config")))) ||
								(names.has("objects") && (names.has("refs") || names.has("config")))))
					if (gitDirectory && !repositories.has(dir)) repositories.set(dir, { sourceCheckout, sourceCache })
					for (const entry of entries) {
						const file = path.join(dir, entry.name)
						if (entry.name === ".git" && !entry.isSymbolicLink()) {
							try {
								const gitDir = await resolveMarker(file)
								if (insideModule(gitDir) && !repositories.has(gitDir)) {
									const cache = worktreePath.isInside(path.join(admin, "modules"), gitDir)
										? path.join(sourceAdmin, path.relative(admin, gitDir))
										: sourceCheckout &&
											path.join(sourceAdmin, "modules", path.relative(module.workspacePath, sourceCheckout))
									repositories.set(gitDir, { sourceCheckout, sourceCache: cache })
								}
							} catch (error) {
								recordError(file, error)
							}
						}
						if (!entry.isDirectory()) continue
						const associated = repositories.get(file)
						const childCheckout =
							associated?.sourceCheckout ??
							(!gitDirectory && !inAdmin && sourceCheckout ? path.join(sourceCheckout, entry.name) : undefined)
						const cache = repositories.get(dir)?.sourceCache ?? sourceCache
						const childCache =
							associated?.sourceCache ??
							(cache && (!gitDirectory || entry.name === "modules") ? path.join(cache, entry.name) : undefined)
						await walk(file, childCheckout, childCache, inAdmin || gitDirectory || entry.name === ".git")
					}
				} catch (error) {
					recordError(dir, error)
				}
			}

			// Collect checkout pointers before inspecting caches, so each cache keeps its source checkout.
			repositories.set(admin, { sourceCheckout: module.workspacePath, sourceCache: sourceAdmin })
			await walk(checkout, module.workspacePath)
			await walk(admin, undefined, sourceAdmin, true)
			for (const [dir, { sourceCheckout, sourceCache }] of repositories) await inspect(dir, sourceCheckout, sourceCache)
		} catch (error) {
			recordError(checkout, error)
		}
	}
	return (
		[
			lost.length ? `Git work would be lost.\n${lost.join("\n")}\nPreserve it or confirm removal to discard it.` : "",
			unchecked.length
				? `Couldn't check Git work in:\n${unchecked.join("\n")}\nInspect these paths by hand, or confirm removal to continue.`
				: "",
		]
			.filter(Boolean)
			.join("\n\n") || undefined
	)
}

/** Mirror checked-out or cached submodules in an independent clone. */
export async function initializeSubmodules(dir: string, source: string, sourceGitDir?: string) {
	const links = await gitlinks(dir, "HEAD")
	if (!links.size) return
	const names = await submoduleNames((args) => git(dir, args))
	const sourceGit = (args: string[]) => (sourceGitDir ? cachedGit(dir, sourceGitDir, args) : git(source, args))
	for (const [relative, commit] of links) {
		const name = submoduleName(names, relative)
		const child = await submodulePath(dir, relative)
		const original = await submodulePath(source, relative)
		const checkedOut = await exists(path.join(original, ".git"))
		if (checkedOut) await assertRepository(original)
		const cached = checkedOut
			? (await git(original, ["rev-parse", "--absolute-git-dir"])).trimEnd()
			: await submoduleCache(sourceGit, source, name)
		if (!(await exists(path.join(child, ".git")))) {
			const local = await git(
				dir,
				[`--git-dir=${cached}`, `--work-tree=${dir}`, "cat-file", "-e", `${commit}^{commit}`],
				undefined,
				{ GIT_NO_LAZY_FETCH: "1" },
			).then(
				() => true,
				() => false,
			)
			if (!checkedOut && !local) {
				Logger.log(`Left ${relative} unset, like your workspace.`)
				continue
			}
			if (!(await emptyOrMissing(child)))
				throw new Error(`Uninitialized submodule ${relative} contains files. Move them aside before retrying.`)
			await git(dir, ["clone", "--no-hardlinks", "--no-checkout", "--", cached, child])
			const upstream = await git(dir, [
				`--git-dir=${cached}`,
				`--work-tree=${dir}`,
				"config",
				"--get",
				"remote.origin.url",
			]).then(
				(out) => out.trim(),
				() => original,
			)
			await git(child, ["remote", "set-url", "origin", upstream])
			if (!local) {
				try {
					await git(child, ["fetch", "--no-tags", "origin", commit])
				} catch {
					await fs.rm(child, { force: true, recursive: true })
					await fs.mkdir(child)
					Logger.warn(
						`Left ${relative} unset. Git couldn't fetch ${commit}. Check the submodule URL and your access, then run git submodule update --init --recursive in the worktree.`,
					)
					continue
				}
			}
			await git(child, ["checkout", "--detach", commit])
			const urlKey = `submodule.${name}.url`
			// Root worktrees share config with the source. Keep any existing local URL override.
			if (
				!(await git(dir, ["config", "--get", urlKey]).then(
					() => true,
					() => false,
				))
			)
				await git(dir, ["config", urlKey, upstream])
		}
		await initializeSubmodules(child, original, cached)
	}
}

/** Own files and staged gitlinks; descendant worktrees and unstaged HEAD moves are inspected separately. */
export async function ownStatus(dir: string): Promise<string> {
	const [status, index] = await Promise.all([
		git(dir, [
			"status",
			"--porcelain",
			"-z",
			"--no-renames",
			"--untracked-files=all",
			"--ignore-submodules=dirty",
			"--",
			".",
			":(exclude).worktrees",
		]),
		git(dir, ["ls-files", "--stage", "-z"]),
	])
	const links = parseGitlinks(index, 1)
	return status
		.split("\0")
		.filter((entry) => entry && (entry[0] !== " " || !links.has(entry.slice(3))))
		.map((entry) => entry.replace(/\n/g, "\\n"))
		.join("\n")
}

export async function importCommit(target: string, source: string, commit: string) {
	await git(target, ["cat-file", "-e", `${commit}^{commit}`]).catch(() =>
		git(target, ["fetch", "--no-tags", "--no-write-fetch-head", source, commit]),
	)
}

/** Move only this checkout's HEAD, never a user's branch. Callers preserve working files separately. */
export async function detachHead(dir: string, commit: string, resetIndex: boolean) {
	await git(dir, ["update-ref", "--no-deref", "HEAD", commit])
	if (resetIndex) await git(dir, ["reset", "--mixed", "--quiet", commit])
}
