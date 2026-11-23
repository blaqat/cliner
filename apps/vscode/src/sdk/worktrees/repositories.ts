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
				if (error) reject(new Error(`${command} ${args[0]}: ${stderr || error.message}`))
				else {
					onStderr?.(stderr)
					resolve(stdout)
				}
			},
		)
		child.stdin?.on("error", () => {})
		child.stdin?.end(input)
	})
}
export const git = async (cwd: string, args: string[], input?: string, env?: NodeJS.ProcessEnv) =>
	run("git", ["-c", "submodule.recurse=false", ...args], await worktreePath.key(cwd), input, {
		GIT_OPTIONAL_LOCKS: "0",
		...env,
	})
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

/** Git retains refs and nested caches after submodule deinit removes the checkout. */
export async function submoduleRemovalWarning(mapping: ThreadWorktree): Promise<string | undefined> {
	const seen = new Set<string>()
	async function visit(
		cwd: string,
		worktree: string,
		module: string,
		repositoryGit: (args: string[]) => Promise<string>,
	): Promise<string | undefined> {
		const links = parseGitlinks(await repositoryGit(["ls-tree", "-rz", "HEAD"]), 2)
		if (!links.size) return undefined
		const names = await submoduleNames(repositoryGit)
		for (const [relative, commit] of links) {
			const child = await submodulePath(worktree, relative)
			const name = [module, relative].filter(Boolean).join("/")
			const checkedOut = await exists(path.join(child, ".git"))
			const gitDir = checkedOut
				? await worktreePath.key((await git(child, ["rev-parse", "--absolute-git-dir"])).trimEnd())
				: await submoduleCache(repositoryGit, worktree, submoduleName(names, relative))
			if (seen.has(gitDir) || !(await exists(gitDir))) continue
			seen.add(gitDir)
			const childGit = (args: string[]) => cachedGit(cwd, gitDir, args)
			const refs = (await childGit(["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads", "refs/remotes"]))
				.trimEnd()
				.split("\n")
			const remoteRefs = refs.filter((ref) => ref.startsWith("refs/remotes/"))
			for (const ref of refs.filter((ref) => ref.startsWith("refs/heads/"))) {
				const [branch, oid] = ref.slice("refs/heads/".length).split(" ")
				if (!remoteRefs.some((remote) => remote.endsWith(`/${branch} ${oid}`)))
					return `${name} has a local branch (${branch}) in this worktree. Preserve it before removing the worktree, or remove and discard it.`
			}
			if (!checkedOut) {
				const base = (await childGit(["rev-parse", "--quiet", "--verify", commit]).catch(() => "")).trim()
				if (
					(
						await childGit(["rev-list", "-1", "--all", "--reflog", "--not", "--remotes", ...(base ? [base] : [])])
					).trim()
				)
					return `${name} has an unpushed commit in its local cache. Preserve it before removing the worktree, or remove and discard it.`
			}
			const warning = await visit(cwd, child, name, childGit)
			if (warning) return warning
		}
		return undefined
	}
	for (const module of mapping.modules) {
		const warning = await visit(module.path, module.path, module.name, (args) => git(module.path, args))
		if (warning) return warning
	}
	return undefined
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
