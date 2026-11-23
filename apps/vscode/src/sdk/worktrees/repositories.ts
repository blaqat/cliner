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
export const git = (cwd: string, args: string[], input?: string, env?: NodeJS.ProcessEnv) =>
	run("git", ["-c", "submodule.recurse=false", ...args], cwd, input, { GIT_OPTIONAL_LOCKS: "0", ...env })
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
	return child
}

async function emptyOrMissing(dir: string) {
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
}

/** Every descendant has its own object database and index, and may have detached HEAD. */
export async function repositories(mapping: ThreadWorktree, recordUnset?: (name: string) => void): Promise<Repository[]> {
	const result: Repository[] = []
	const unset = new Set(mapping.unsetSubmodules)
	async function visit(module: WorktreeModule, configured: boolean, indexHead?: string) {
		await assertRepository(module.path)
		result.push({ ...module, configured, indexHead })
		for (const { relative, before, after, index } of await submoduleLinks(module.path, module.base, "HEAD", true)) {
			if (!before || !after)
				throw new Error(
					`Submodule added or removed at ${relative}. Commit or preserve this workspace before removing it; copying submodule layout changes is not supported.`,
				)
			const name = [module.name, relative].filter(Boolean).join("/")
			const child = await submodulePath(module.path, relative)
			if ((recordUnset || unset.has(name)) && before === after && after === index && (await emptyOrMissing(child))) {
				recordUnset?.(name)
				continue
			}
			await visit(
				{
					name,
					path: child,
					workspacePath: path.join(module.workspacePath, relative),
					base: before,
				},
				false,
				index,
			)
		}
	}
	for (const module of mapping.modules) await visit(module, true)
	return result
}

/** Mirror checked-out or cached submodules in an independent clone. */
export async function initializeSubmodules(dir: string, source: string, sourceGitDir?: string) {
	const links = await gitlinks(dir, "HEAD")
	if (!links.size) return
	const metadata = sourceGitDir ?? (await git(source, ["rev-parse", "--absolute-git-dir"])).trim()
	const entries = (
		await git(dir, ["config", "--file", ".gitmodules", "--null", "--get-regexp", "^submodule\\..*\\.path$"])
	).split("\0")
	for (const [relative, commit] of links) {
		const key = entries.find((entry) => entry.slice(entry.indexOf("\n") + 1) === relative)?.split("\n")[0]
		if (!key) throw new Error(`Submodule path missing from .gitmodules: ${relative}`)
		const name = key.slice("submodule.".length, -".path".length)
		const child = await submodulePath(dir, relative)
		const original = await submodulePath(source, relative)
		const checkedOut = await exists(path.join(original, ".git"))
		let cached = await submodulePath(path.join(metadata, "modules"), name)
		if (checkedOut) {
			await assertRepository(original)
			cached = (await git(original, ["rev-parse", "--absolute-git-dir"])).trim()
		}
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
			const urlKey = key.slice(0, -"path".length) + "url"
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
