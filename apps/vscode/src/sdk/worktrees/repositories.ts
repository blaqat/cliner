import { execFile } from "node:child_process"
import { promises as fs } from "node:fs"
import path from "node:path"
import type { ThreadWorktree, WorktreeModule } from "@shared/thread-worktrees"

export async function run(
	command: string,
	args: string[],
	cwd: string,
	input?: string,
	env?: NodeJS.ProcessEnv,
): Promise<string> {
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
		(await fs.realpath((await git(dir, ["rev-parse", "--show-toplevel"])).trim())) !== (await fs.realpath(dir))
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
	if (!child.startsWith(dir + path.sep) || !(await fs.realpath(child)).startsWith((await fs.realpath(dir)) + path.sep))
		throw new Error(`Submodule outside its repository: ${relative}`)
	return child
}

export interface Repository extends WorktreeModule {
	configured: boolean
	/** Commit the parent index names, which can differ from the checked-out child HEAD. */
	indexHead?: string
}

/** Every descendant has its own object database and index, and may have detached HEAD. */
export async function repositories(mapping: ThreadWorktree): Promise<Repository[]> {
	const result: Repository[] = []
	async function visit(module: WorktreeModule, configured: boolean, indexHead?: string) {
		await assertRepository(module.path)
		result.push({ ...module, configured, indexHead })
		for (const { relative, before, after, index } of await submoduleLinks(module.path, module.base, "HEAD", true)) {
			if (!before || !after)
				throw new Error(
					`Submodule added or removed at ${relative}. Commit or preserve this workspace before removing it; copying submodule layout changes is not supported.`,
				)
			await visit(
				{
					name: [module.name, relative].filter(Boolean).join("/"),
					path: await submodulePath(module.path, relative),
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

/** Clone local caches independently, including deinitialized descendants. Keep each source's upstream URL. */
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
		const child = path.resolve(dir, relative)
		const original = path.resolve(source, relative)
		if (!child.startsWith(dir + path.sep)) throw new Error(`Submodule outside its repository: ${relative}`)
		let cached: string
		if (await exists(path.join(original, ".git"))) {
			await assertRepository(original)
			cached = (await git(original, ["rev-parse", "--absolute-git-dir"])).trim()
		} else {
			cached = path.resolve(metadata, "modules", name)
			if (!cached.startsWith(path.join(metadata, "modules") + path.sep)) throw new Error(`Invalid submodule name: ${name}`)
			await git(dir, [`--git-dir=${cached}`, `--work-tree=${dir}`, "cat-file", "-e", `${commit}^{commit}`]).catch(() => {
				throw new Error(
					`Initialize ${relative} in your workspace with git submodule update --init --recursive, then retry workspace creation.`,
				)
			})
		}
		if (!(await exists(path.join(child, ".git")))) {
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
			const urlKey = key.slice(0, -"path".length) + "url"
			// Root worktrees share config with the source. Keep any existing local URL override.
			if (
				!(await git(dir, ["config", "--get", urlKey]).then(
					() => true,
					() => false,
				))
			)
				await git(dir, ["config", urlKey, upstream])
			await git(child, ["checkout", "--detach", commit])
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
